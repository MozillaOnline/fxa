/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var validators = require('./validators')
var HEX_STRING = validators.HEX_STRING
var BASE64_JWT = validators.BASE64_JWT
var DISPLAY_SAFE_UNICODE = validators.DISPLAY_SAFE_UNICODE
var URLSAFEBASE64 = validators.URLSAFEBASE64

var butil = require('../crypto/butil')
var openid = require('openid')
var userAgent = require('../userAgent')
var url = require('url')
var requestHelper = require('../routes/utils/request_helper')
var metricsContext = require('../metrics/context')

module.exports = function (
  log,
  crypto,
  P,
  uuid,
  isA,
  error,
  db,
  mailer,
  Password,
  config,
  customs,
  isPreVerified,
  checkPassword,
  push
  ) {

  var OPENID_EXTENSIONS = [
    new openid.AttributeExchange(
      {
        'http://axschema.org/contact/email': 'optional'
      }
    )
  ]

  function isOpenIdProviderAllowed(id) {
    if (typeof(id) !== 'string') { return false }
    var hostname = url.parse(id).hostname
    return config.openIdProviders.some(
      function (allowed) {
        return hostname === url.parse(allowed).hostname
      }
    )
  }

  var routes = [
    {
      method: 'POST',
      path: '/account/create',
      config: {
        validate: {
          payload: {
            email: validators.email().required(),
            authPW: isA.string().min(64).max(64).regex(HEX_STRING).required(),
            preVerified: isA.boolean(),
            service: isA.string().max(16).alphanum().optional(),
            redirectTo: validators.redirectTo(config.smtp.redirectDomain).optional(),
            resume: isA.string().max(2048).optional(),
            preVerifyToken: isA.string().max(2048).regex(BASE64_JWT).optional(),
            metricsContext: metricsContext.schema
          }
        },
        response: {
          schema: {
            uid: isA.string().regex(HEX_STRING).required(),
            sessionToken: isA.string().regex(HEX_STRING).required(),
            keyFetchToken: isA.string().regex(HEX_STRING).optional(),
            authAt: isA.number().integer()
          }
        }
      },
      handler: function accountCreate(request, reply) {
        log.begin('Account.create', request)

        var form = request.payload
        var query = request.query
        var email = form.email
        var authSalt = crypto.randomBytes(32)
        var authPW = Buffer(form.authPW, 'hex')
        var locale = request.app.acceptLanguage
        var userAgentString = request.headers['user-agent']
        var service = form.service || query.service
        var preVerified, password, verifyHash, account, sessionToken

        customs.check(request.app.clientAddress, email, 'accountCreate')
          .then(db.emailRecord.bind(db, email))
          .then(deleteAccount, ignoreUnknownAccountError)
          .then(checkPreVerified)
          .then(createPassword)
          .then(createAccount)
          .then(createSessionToken)
          .then(sendVerifyCode)
          .then(createResponse)
          .done(reply, reply)

        function deleteAccount (emailRecord) {
          if (emailRecord.emailVerified) {
            throw error.accountExists(email)
          }

          request.app.accountRecreated = true
          return db.deleteAccount(emailRecord)
        }

        function ignoreUnknownAccountError (err) {
          if (err.errno !== error.ERRNO.ACCOUNT_UNKNOWN) {
            throw err
          }
        }

        function checkPreVerified () {
          return isPreVerified(form.email, form.preVerifyToken)
            .then(
              function (result) {
                preVerified = result
              }
            )
        }

        function createPassword () {
          password = new Password(authPW, authSalt, config.verifierVersion)
          return password.verifyHash()
            .then(
              function (result) {
                verifyHash = result
              }
            )
        }

        function createAccount () {
          if (!locale) {
            // We're seeing a surprising number of accounts created
            // without a proper locale. Log details to help debug this.
            log.info({
              op: 'account.create.emptyLocale',
              email: email,
              locale: locale,
              agent: userAgentString
            })
          }

          return db.createAccount({
            uid: uuid.v4('binary'),
            createdAt: Date.now(),
            email: email,
            emailCode: crypto.randomBytes(16),
            emailVerified: form.preVerified || preVerified,
            kA: crypto.randomBytes(32),
            wrapWrapKb: crypto.randomBytes(32),
            accountResetToken: null,
            passwordForgotToken: null,
            authSalt: authSalt,
            verifierVersion: password.version,
            verifyHash: verifyHash,
            verifierSetAt: Date.now(),
            locale: locale
          })
          .then(
            function (result) {
              account = result

              log.activityEvent('account.created', request, {
                uid: account.uid.toString('hex')
              })

              if (account.emailVerified) {
                log.event('verified', request, {
                  email: account.email,
                  uid: account.uid,
                  locale: account.locale
                })
              }

              if (service === 'sync') {
                log.event('login', request, {
                  service: 'sync',
                  uid: account.uid,
                  email: account.email,
                  deviceCount: 1,
                  userAgent: request.headers['user-agent']
                })
              }
            }
          )
        }

        function createSessionToken () {
          return db.createSessionToken({
            uid: account.uid,
            email: account.email,
            emailCode: account.emailCode,
            emailVerified: account.emailVerified,
            verifierSetAt: account.verifierSetAt,
            createdAt: optionallyOverrideCreatedAt()
          }, userAgentString)
            .then(
              function (result) {
                sessionToken = result
              }
            )
        }

        function optionallyOverrideCreatedAt () {
          var createdAt = parseInt(query._createdAt)
          if (createdAt < Date.now() && ! config.isProduction) {
            return createdAt
          }
        }

        function sendVerifyCode () {
          if (! account.emailVerified) {
            mailer.sendVerifyCode(account, account.emailCode, {
              service: form.service || query.service,
              redirectTo: form.redirectTo,
              resume: form.resume,
              acceptLanguage: request.app.acceptLanguage
            }).catch(function (err) {
              log.error({ op: 'mailer.sendVerifyCode.1', err: err })
            })
          }
        }

        function createResponse () {
          var response = {
            uid: account.uid.toString('hex'),
            sessionToken: sessionToken.data.toString('hex'),
            authAt: sessionToken.lastAuthAt()
          }

          if (query.keys !== 'true') {
            return P.resolve(response)
          }

          return password.unwrap(account.wrapWrapKb)
            .then(
              function (wrapKb) {
                return db.createKeyFetchToken({
                  uid: account.uid,
                  kA: account.kA,
                  wrapKb: wrapKb,
                  emailVerified: account.emailVerified
                })
              }
            )
            .then(
              function (keyFetchToken) {
                response.keyFetchToken = keyFetchToken.data.toString('hex')
                return response
              }
            )
        }
      }
    },
    {
      method: 'POST',
      path: '/account/login',
      config: {
        validate: {
          payload: {
            email: validators.email().required(),
            authPW: isA.string().min(64).max(64).regex(HEX_STRING).required(),
            service: isA.string().max(16).alphanum().optional(),
            redirectTo: isA.string().uri().optional(),
            resume: isA.string().optional(),
            reason: isA.string().max(16).optional(),
            metricsContext: metricsContext.schema
          }
        },
        response: {
          schema: {
            uid: isA.string().regex(HEX_STRING).required(),
            sessionToken: isA.string().regex(HEX_STRING).required(),
            keyFetchToken: isA.string().regex(HEX_STRING).optional(),
            verificationMethod: isA.string().optional(),
            verificationReason: isA.string().optional(),
            verified: isA.boolean().required(),
            authAt: isA.number().integer()
          }
        }
      },
      handler: function (request, reply) {
        log.begin('Account.login', request)

        var form = request.payload
        var email = form.email
        var authPW = Buffer(form.authPW, 'hex')
        var service = request.payload.service || request.query.service
        var emailRecord, sessionToken

        customs.check(request.app.clientAddress, email, 'accountLogin')
          .then(readEmailRecord)
          .then(createSessionToken)
          .then(emitSyncLoginEvent)
          .then(sendNewDeviceLoginNotification)
          .then(createResponse)
          .done(reply, reply)

        function readEmailRecord (result) {
          return db.emailRecord(email)
            .then(
              function (result) {
                emailRecord = result

                if(email !== emailRecord.email) {
                  customs.flag(request.app.clientAddress, {
                    email: email,
                    errno: error.ERRNO.INCORRECT_PASSWORD
                  })
                  throw error.incorrectPassword(emailRecord.email, email)
                }

                if (emailRecord.lockedAt) {
                  throw error.lockedAccount()
                }

                return checkPassword(emailRecord, authPW, request.app.clientAddress)
                  .then(
                    function (match) {
                      if (! match) {
                        throw error.incorrectPassword(emailRecord.email, email)
                      }
                    }
                  )
              },
              function (err) {
                if (err.errno === error.ERRNO.ACCOUNT_UNKNOWN) {
                  customs.flag(request.app.clientAddress, {
                    email: email,
                    errno: err.errno
                  })
                }
                throw err
              }
            )
        }

        function createSessionToken () {
          log.activityEvent('account.login', request, {
            uid: emailRecord.uid.toString('hex')
          })

          return db.createSessionToken({
            uid: emailRecord.uid,
            email: emailRecord.email,
            emailCode: emailRecord.emailCode,
            emailVerified: emailRecord.emailVerified,
            verifierSetAt: emailRecord.verifierSetAt
          }, request.headers['user-agent'])
            .then(
              function (result) {
                sessionToken = result
              }
            )
        }

        function emitSyncLoginEvent () {
          if (service === 'sync' && request.payload.reason === 'signin') {
            return db.sessions(emailRecord.uid)
              .then(
                function (sessions) {
                  log.event('login', request, {
                    service: 'sync',
                    uid: emailRecord.uid,
                    email: emailRecord.email,
                    deviceCount: sessions.length,
                    userAgent: request.headers['user-agent']
                  })
                }
              )
          }
        }

        function sendNewDeviceLoginNotification () {
          if (config.newLoginNotificationEnabled && requestHelper.wantsKeys(request)) {
            // The response doesn't have to wait for this,
            // so we don't return the promise.
            mailer.sendNewDeviceLoginNotification(
              emailRecord.email,
              userAgent.call({
                acceptLanguage: request.app.acceptLanguage,
                timestamp: Date.now()
              }, request.headers['user-agent'])
            )
          }
        }

        function createResponse () {
          var response = {
            uid: sessionToken.uid.toString('hex'),
            sessionToken: sessionToken.data.toString('hex'),
            verified: sessionToken.emailVerified,
            authAt: sessionToken.lastAuthAt()
          }

          if (! requestHelper.wantsKeys(request)) {
            return P.resolve(response)
          }

          var password = new Password(
            authPW,
            emailRecord.authSalt,
            emailRecord.verifierVersion
          )
          return password.unwrap(emailRecord.wrapWrapKb)
            .then(
              function (wrapKb) {
                return db.createKeyFetchToken({
                  uid: emailRecord.uid,
                  kA: emailRecord.kA,
                  wrapKb: wrapKb,
                  emailVerified: emailRecord.emailVerified
                })
              }
            )
            .then(
              function (keyFetchToken) {
                response.keyFetchToken = keyFetchToken.data.toString('hex')
                return response
              }
            )
        }
      }
    },
    {
      method: 'GET',
      path: '/account/openid/login',
      handler: function (request, reply) {

        var unverifiedId = request.url.query && request.url.query['openid.claimed_id']
        if (!isOpenIdProviderAllowed(unverifiedId)) {
          log.warn({op: 'Account.openid', id: unverifiedId })
          return reply({ err: 'This OpenID Provider is not allowed' }).code(400)
        }

        openid.verifyAssertion(
          url.format(request.url),
          function (err, assertion) {
            if (err || !assertion || !assertion.authenticated) {
              log.warn({ op: 'Account.openid', err: err, assertion: assertion })
              return reply({ err: err.message || 'Unknown Account' }).code(400)
            }
            var id = assertion.claimedIdentifier
            var locale = request.app.acceptLanguage

            db.openIdRecord(id)
              .then(
                function (record) {
                  return record
                },
                function (err) {
                  if (err.errno !== error.ERRNO.ACCOUNT_UNKNOWN) {
                    throw err
                  }
                  var uid = uuid.v4('binary')
                  var email = assertion.email || uid.toString('hex') + '@uid.' + config.domain
                  var authSalt = crypto.randomBytes(32)
                  var kA = crypto.randomBytes(32)
                  return db.createAccount(
                    {
                      uid: uid,
                      createdAt: Date.now(),
                      email: email,
                      emailCode: crypto.randomBytes(16),
                      emailVerified: true,
                      kA: kA,
                      wrapWrapKb: crypto.randomBytes(32),
                      accountResetToken: null,
                      passwordForgotToken: null,
                      authSalt: authSalt,
                      verifierVersion: 0,
                      verifyHash: crypto.randomBytes(32),
                      openId: id,
                      verifierSetAt: Date.now(),
                      locale: locale
                    }
                  )
                }
              )
              .then(
                function (account) {
                  return db.createSessionToken(
                    {
                      uid: account.uid,
                      email: account.email,
                      emailCode: account.emailCode,
                      emailVerified: true,
                      verifierSetAt: account.verifierSetAt
                    }
                  )
                  .then(
                    function (sessionToken) {
                      if (! requestHelper.wantsKeys(request)) {
                        return P.resolve({
                          sessionToken: sessionToken
                        })
                      }
                      return db.createKeyFetchToken(
                        {
                          uid: account.uid,
                          kA: account.kA,
                          // wrapKb is undefined without a password.
                          // wrapWrapKb has the properties we need for this
                          // value; Its stable, random, and will change on
                          // account reset.
                          wrapKb: account.wrapWrapKb,
                          emailVerified: true
                        }
                      )
                      .then(
                        function (keyFetchToken) {
                          return {
                            sessionToken: sessionToken,
                            keyFetchToken: keyFetchToken,
                            unwrapBKey: butil.xorBuffers(
                              account.kA,
                              account.wrapWrapKb
                            )
                            // The browser using these values for unwrapBKey
                            // and wrapKb (from above) will yield kA
                            // as the Sync key instead of kB
                          }
                        }
                      )
                    }
                  )
                  .then(
                    function (tokens) {
                      reply(
                        {
                          uid: tokens.sessionToken.uid.toString('hex'),
                          email: account.email,
                          session: tokens.sessionToken.data.toString('hex'),
                          key: tokens.keyFetchToken ?
                            tokens.keyFetchToken.data.toString('hex')
                            : undefined,
                          unwrap: tokens.unwrapBKey ?
                            tokens.unwrapBKey.toString('hex')
                            : undefined
                        }
                      )
                    }
                  )
                }
              )
              .catch(
                function (err) {
                  log.error({ op: 'Account.openid', err: err })
                  reply({
                    err: err.message
                  }).code(500)
                }
              )
          },
          true, // stateless
          OPENID_EXTENSIONS,
          false // strict
        )
      }
    },
    {
      method: 'GET',
      path: '/account/status',
      config: {
        auth: {
          mode: 'optional',
          strategy: 'sessionToken'
        },
        validate: {
          query: {
            uid: isA.string().min(32).max(32).regex(HEX_STRING)
          }
        }
      },
      handler: function (request, reply) {
        var sessionToken = request.auth.credentials
        if (sessionToken) {
          reply({ exists: true, locale: sessionToken.locale })
        }
        else if (request.query.uid) {
          var uid = Buffer(request.query.uid, 'hex')
          db.account(uid)
            .done(
              function (account) {
                reply({ exists: true })
              },
              function (err) {
                if (err.errno === error.ERRNO.ACCOUNT_UNKNOWN) {
                  return reply({ exists: false })
                }
                reply(err)
              }
            )
        }
        else {
          reply(error.missingRequestParameter('uid'))
        }
      }
    },
    {
      method: 'POST',
      path: '/account/status',
      config: {
        validate: {
          payload: {
            email: validators.email().required()
          }
        },
        response: {
          schema: {
            exists: isA.boolean().required()
          }
        }
      },
      handler: function (request, reply) {
        var email = request.payload.email

        customs.check(
          request.app.clientAddress,
          email,
          'accountStatusCheck')
          .then(
            db.accountExists.bind(db, email)
          )
          .done(
            function (exist) {
              reply({
                exists: exist
              })
            },
            function (err) {
              if (err.errno === error.ERRNO.ACCOUNT_UNKNOWN) {
                return reply({ exists: false })
              }
              reply(err)
            }
          )
      }
    },
    {
      method: 'GET',
      path: '/account/profile',
      config: {
        auth: {
          mode: 'optional',
          strategies: [
            'sessionToken',
            'oauthToken'
          ]
        }
      },
      handler: function (request, reply) {
        var auth = request.auth
        var uid
        if (auth.strategy === 'sessionToken') {
          uid = auth.credentials.uid
        } else {
          uid = Buffer(auth.credentials.user, 'hex')
        }
        function hasProfileItemScope(item) {
          if (auth.strategy === 'sessionToken') {
            return true
          }
          var scopes = auth.credentials.scope
          for (var i = 0; i < scopes.length; i++) {
            if (scopes[i] === 'profile') {
              return true
            }
            if (scopes[i] === 'profile:write') {
              return true
            }
            if (scopes[i] === 'profile:' + item) {
              return true
            }
            if (scopes[i] === 'profile:' + item + ':write') {
              return true
            }
          }
          return false
        }
        db.account(uid)
          .done(
            function (account) {
              reply({
                email: hasProfileItemScope('email') ? account.email : undefined,
                locale: hasProfileItemScope('locale') ? account.locale : undefined
              })
            },
            function (err) {
              reply(err)
            }
          )
      }
    },
    {
      method: 'GET',
      path: '/account/keys',
      config: {
        auth: {
          strategy: 'keyFetchToken'
        },
        response: {
          schema: {
            bundle: isA.string().regex(HEX_STRING)
          }
        }
      },
      handler: function accountKeys(request, reply) {
        log.begin('Account.keys', request)
        var keyFetchToken = request.auth.credentials
        if (!keyFetchToken.emailVerified) {
          // don't delete the token on use until the account is verified
          return reply(error.unverifiedAccount())
        }
        db.deleteKeyFetchToken(keyFetchToken)
          .then(
            function () {
              return {
                bundle: keyFetchToken.keyBundle.toString('hex')
              }
            }
          )
          .done(reply, reply)
      }
    },
    {
      method: 'POST',
      path: '/account/device',
      config: {
        auth: {
          strategy: 'sessionTokenWithDevice'
        },
        validate: {
          payload: isA.alternatives().try(
            isA.object({
              id: isA.string().length(32).regex(HEX_STRING).required(),
              name: isA.string().max(255).regex(DISPLAY_SAFE_UNICODE).optional(),
              type: isA.string().max(16).optional(),
              pushCallback: isA.string().uri({ scheme: 'https' }).max(255).optional().allow(''),
              pushPublicKey: isA.string().max(88).regex(URLSAFEBASE64).optional().allow(''),
              pushAuthKey: isA.string().max(24).regex(URLSAFEBASE64).optional().allow('')
            }).or('name', 'type', 'pushCallback', 'pushPublicKey', 'pushAuthKey').and('pushPublicKey', 'pushAuthKey'),
            isA.object({
              name: isA.string().max(255).regex(DISPLAY_SAFE_UNICODE).required(),
              type: isA.string().max(16).required(),
              pushCallback: isA.string().uri({ scheme: 'https' }).max(255).optional().allow(''),
              pushPublicKey: isA.string().max(88).regex(URLSAFEBASE64).optional().allow(''),
              pushAuthKey: isA.string().max(24).regex(URLSAFEBASE64).optional().allow('')
            }).and('pushPublicKey', 'pushAuthKey')
          )
        },
        response: {
          schema: isA.object({
            id: isA.string().length(32).regex(HEX_STRING).required(),
            createdAt: isA.number().positive().optional(),
            // We previously allowed devices to register with arbitrry unicode names,
            // so we can't assert DISPLAY_SAFE_UNICODE in the response schema.
            name: isA.string().max(255).optional(),
            type: isA.string().max(16).optional(),
            pushCallback: isA.string().uri({ scheme: 'https' }).max(255).optional().allow(''),
            pushPublicKey: isA.string().max(88).regex(URLSAFEBASE64).optional().allow(''),
            pushAuthKey: isA.string().max(24).regex(URLSAFEBASE64).optional().allow('')
          }).and('pushPublicKey', 'pushAuthKey')
        }
      },
      handler: function (request, reply) {
        log.begin('Account.device', request)
        var payload = request.payload
        var sessionToken = request.auth.credentials
        if (payload.id) {
          // Don't write out the update if nothing has actually changed.
          if (isSpuriousUpdate(payload, sessionToken)) {
            log.increment('device.update.spurious')
            return reply(payload)
          }
          // We also reserve the right to disable updates until
          // we're confident clients are behaving correctly.
          if (config.deviceUpdatesEnabled === false) {
            throw error.featureNotEnabled()
          }
        }
        if (payload.pushCallback && (!payload.pushPublicKey || !payload.pushAuthKey)) {
          payload.pushPublicKey = ''
          payload.pushAuthKey = ''
        }
        var operation = payload.id ? 'updateDevice' : 'createDevice'
        db[operation](sessionToken.uid, sessionToken.tokenId, payload).then(
          function (device) {
            if (operation === 'createDevice') {
              log.event('device:create', request, {
                uid: sessionToken.uid,
                id: device.id,
                type: device.type,
                timestamp: device.createdAt
              })
            }
            reply(butil.unbuffer(device))
            push.notifyDeviceConnected(sessionToken.uid, device.name, device.id.toString('hex'))
          },
          reply
        )

        // Clients have been known to send spurious device updates,
        // which generates lots of unnecessary database load.
        // Check if anything has actually changed, and log lots metrics on what.
        function isSpuriousUpdate(paylad, token) {
          var spurious = true
          if(! token.deviceId || payload.id !== token.deviceId.toString('hex')) {
            spurious = false
            log.increment('device.update.sessionToken')
          }
          if (payload.name && payload.name !== token.deviceName) {
            spurious = false
            log.increment('device.update.name')
          }
          if (payload.type && payload.type !== token.deviceType) {
            spurious = false
            log.increment('device.update.type')
          }
          if (payload.pushCallback && payload.pushCallback !== token.deviceCallbackURL) {
            spurious = false
            log.increment('device.update.pushCallback')
          }
          if (payload.pushPublicKey && payload.pushPublicKey !== token.deviceCallbackPublicKey) {
            spurious = false
            log.increment('device.update.pushPublicKey')
          }
          return spurious
        }

      }
    },
    {
      method: 'GET',
      path: '/account/devices',
      config: {
        auth: {
          strategy: 'sessionToken'
        },
        response: {
          schema: isA.array().items(isA.object({
            id: isA.string().length(32).regex(HEX_STRING).required(),
            isCurrentDevice: isA.boolean().required(),
            lastAccessTime: isA.number().min(0).required().allow(null),
            // We previously allowed devices to register with arbitrry unicode names,
            // so we can't assert DISPLAY_SAFE_UNICODE in the response schema.
            name: isA.string().max(255).required(),
            type: isA.string().max(16).required(),
            pushCallback: isA.string().uri({ scheme: 'https' }).max(255).optional().allow('').allow(null),
            pushPublicKey: isA.string().max(88).regex(URLSAFEBASE64).optional().allow('').allow(null),
            pushAuthKey: isA.string().max(24).regex(URLSAFEBASE64).optional().allow('').allow(null)
          }).and('pushPublicKey', 'pushAuthKey'))
        }
      },
      handler: function (request, reply) {
        log.begin('Account.devices', request)
        var sessionToken = request.auth.credentials
        var uid = sessionToken.uid
        db.devices(uid).then(
          function (devices) {
            reply(devices.map(function (device) {
              device.isCurrentDevice =
                device.sessionToken.toString('hex') === sessionToken.tokenId.toString('hex')
              delete device.sessionToken
              return butil.unbuffer(device)
            }))
          },
          reply
        )
      }
    },
    {
      method: 'POST',
      path: '/account/device/destroy',
      config: {
        auth: {
          strategy: 'sessionToken'
        },
        validate: {
          payload: {
            id: isA.string().length(32).regex(HEX_STRING).required()
          }
        },
        response: {
          schema: {}
        }
      },
      handler: function (request, reply) {
        log.begin('Account.deviceDestroy', request)
        var sessionToken = request.auth.credentials
        var uid = sessionToken.uid
        var id = request.payload.id
        push.notifyDeviceDisconnected(uid, id).then(deleteDbDevice, deleteDbDevice)

        function deleteDbDevice() {
          db.deleteDevice(uid, id).then(
            function (result) {
              log.event('device:delete', request, {
                uid: uid,
                id: id,
                timestamp: Date.now()
              })
              reply(result)
            },
            reply
          )
        }
      }
    },
    {
      method: 'GET',
      path: '/recovery_email/status',
      config: {
        auth: {
          strategy: 'sessionToken'
        },
        validate: {
          query: {
            reason: isA.string().max(16).optional()
          }
        },
        response: {
          schema: {
            // There's code in the handler that checks for a valid email,
            // no point adding overhead by doing it again here.
            email: isA.string().required(),
            verified: isA.boolean().required(),
            sessionVerified: isA.boolean().optional(),
            emailVerified: isA.boolean().optional()
          }
        }
      },
      handler: function (request, reply) {
        log.begin('Account.RecoveryEmailStatus', request)
        var sessionToken = request.auth.credentials
        if (request.query && request.query.reason === 'push') {
          // only log recovery_email requests with 'push' to avoid sending too many requests.
          log.increment('recovery_email_reason.push')
        }

        cleanUpIfAccountInvalid()
          .then(createResponse)
          .done(reply, reply)

        function cleanUpIfAccountInvalid() {
          // Some historical bugs mean we've allowed creation
          // of accounts with invalid email addresses. These
          // can never be verified, so the best we can do is
          // to delete them so the browser will stop polling.
          if (!sessionToken.emailVerified) {
            if (!validators.isValidEmailAddress(sessionToken.email)) {
              return db.deleteAccount(sessionToken)
                .then(
                  function () {
                    // Act as though we deleted the account asynchronously
                    // and caused the sessionToken to become invalid.
                    throw error.invalidToken()
                  }
                )
            }
          }
          return P.resolve()
        }

        function createResponse() {
          return {
             email: sessionToken.email,
             verified: sessionToken.emailVerified
           }
        }
      }
    },
    {
      method: 'POST',
      path: '/recovery_email/resend_code',
      config: {
        auth: {
          strategy: 'sessionToken'
        },
        validate: {
          payload: {
            service: isA.string().max(16).alphanum().optional(),
            redirectTo: validators.redirectTo(config.smtp.redirectDomain).optional(),
            resume: isA.string().max(2048).optional()
          }
        }
      },
      handler: function (request, reply) {
        log.begin('Account.RecoveryEmailResend', request)
        var sessionToken = request.auth.credentials
        var service = request.payload.service || request.query.service
        if (sessionToken.emailVerified ||
            Date.now() - sessionToken.verifierSetAt < config.smtp.resendBlackoutPeriod) {
          return reply({})
        }
        customs.check(
          request.app.clientAddress,
          sessionToken.email,
          'recoveryEmailResendCode')
          .then(
            mailer.sendVerifyCode.bind(
              mailer,
              sessionToken,
              sessionToken.emailCode,
              {
                service: service,
                redirectTo: request.payload.redirectTo,
                resume: request.payload.resume,
                acceptLanguage: request.app.acceptLanguage
              }
            )
          )
          .done(
            function () {
              reply({})
            },
            reply
          )
      }
    },
    {
      method: 'POST',
      path: '/recovery_email/verify_code',
      config: {
        validate: {
          payload: {
            uid: isA.string().max(32).regex(HEX_STRING).required(),
            code: isA.string().min(32).max(32).regex(HEX_STRING).required()
          }
        }
      },
      handler: function (request, reply) {
        log.begin('Account.RecoveryEmailVerify', request)
        var uid = request.payload.uid
        var code = Buffer(request.payload.code, 'hex')
        db.account(Buffer(uid, 'hex'))
          .then(
            function (account) {
              // If the account is already verified, they may be e.g.
              // clicking a stale link.  Silently succeed.
              if (account.emailVerified) {
                log.increment('account.already_verified')
                return true
              }
              if (!butil.buffersAreEqual(code, account.emailCode)) {
                throw error.invalidVerificationCode()
              }
              log.timing('account.verified', Date.now() - account.createdAt)
              log.event('verified', request, {
                email: account.email,
                uid: account.uid,
                locale: account.locale
              })
              log.increment('account.verified')

              // send a push notification to all devices that the account changed
              push.notifyUpdate(uid, 'accountVerify')

              return db.verifyEmail(account)
                .then(mailer.sendPostVerifyEmail.bind(
                    mailer,
                    account.email,
                    {
                      acceptLanguage: request.app.acceptLanguage
                    }
                  )
                )
            }
          )
          .done(
            function () {
              reply({})
            },
            reply
          )
      }
    },
    {
      method: 'POST',
      path: '/account/unlock/resend_code',
      config: {
        validate: {
          payload: {
            email: validators.email().required(),
            service: isA.string().max(16).alphanum().optional(),
            redirectTo: validators.redirectTo(config.smtp.redirectDomain).optional(),
            resume: isA.string().max(2048).optional()
          }
        }
      },
      handler: function (request, reply) {
        log.begin('Account.UnlockCodeResend', request)
        var email = request.payload.email
        var emailRecord
        var service = request.payload.service || request.query.service

        customs.check(
          request.app.clientAddress,
          email,
          'accountUnlockResendCode')
          .then(
            db.emailRecord.bind(db, email)
          )
          .then(
            function (_emailRecord) {
              if (! _emailRecord.lockedAt) {
                throw error.accountNotLocked(email)
              }

              emailRecord = _emailRecord
              return db.unlockCode(emailRecord)
            }
          )
          .then(
            function (unlockCode) {
              return mailer.sendUnlockCode(
                emailRecord,
                unlockCode,
                {
                  service: service,
                  redirectTo: request.payload.redirectTo,
                  resume: request.payload.resume,
                  acceptLanguage: request.app.acceptLanguage
                }
              )
            }
          )
          .done(
            function () {
              reply({})
            },
            reply
          )
      }
    },
    {
      method: 'POST',
      path: '/account/unlock/verify_code',
      config: {
        validate: {
          payload: {
            uid: isA.string().max(32).regex(HEX_STRING).required(),
            code: isA.string().min(32).max(32).regex(HEX_STRING).required()
          }
        }
      },
      handler: function (request, reply) {
        log.begin('Account.UnlockCodeVerify', request)
        var uid = request.payload.uid
        var code = Buffer(request.payload.code, 'hex')
        db.account(Buffer(uid, 'hex'))
          .then(
            function (account) {
              // If the account isn't actually locked, they may be
              // e.g. clicking a stale link.  Silently succeed.
              if (! account.lockedAt) {
                return
              }
              return db.unlockCode(account)
                .then(
                  function (expectedCode) {
                    if (!butil.buffersAreEqual(code, expectedCode)) {
                      throw error.invalidVerificationCode()
                    }
                    log.info({
                      op: 'account.unlock',
                      email: account.email,
                      uid: account.uid
                    })
                    return db.unlockAccount(account)
                  }
                )
            }
          )
          .done(
            function () {
              reply({})
            },
            reply
          )
      }
    },
    {
      method: 'POST',
      path: '/account/reset',
      config: {
        auth: {
          strategy: 'accountResetToken',
          payload: 'required'
        },
        validate: {
          payload: {
            authPW: isA.string().min(64).max(64).regex(HEX_STRING).required(),
            metricsContext: metricsContext.schema,
            sessionToken: isA.boolean().optional()
          }
        }
      },
      handler: function accountReset(request, reply) {
        log.begin('Account.reset', request)
        var accountResetToken = request.auth.credentials
        var authPW = Buffer(request.payload.authPW, 'hex')
        var authSalt = crypto.randomBytes(32)
        var password = new Password(authPW, authSalt, config.verifierVersion)
        var account, sessionToken, keyFetchToken, verifyHash, wrapKb
        var hasSessionToken = request.payload.sessionToken

        return resetAccountData()
          .then(createSessionToken)
          .then(createKeyFetchToken)
          .then(createResponse)
          .done(reply, reply)

        function resetAccountData () {
          return password.verifyHash()
            .then(
              function (verifyHashData) {
                verifyHash = verifyHashData

                return db.resetAccount(
                  accountResetToken,
                  {
                    authSalt: authSalt,
                    verifyHash: verifyHash,
                    wrapWrapKb: crypto.randomBytes(32),
                    verifierVersion: password.version
                  }
                )
              }
            )
            .then(
              function () {
                // Notify all devices that the account has changed.
                push.notifyUpdate(accountResetToken.uid, 'passwordReset')

                return db.account(accountResetToken.uid)
              }
            )
            .then(
              function (accountData) {
                account = accountData
                log.activityEvent('account.reset', request, {
                  uid: account.uid.toString('hex')
                })
                log.event('reset', request, {
                  uid: account.uid.toString('hex') + '@' + config.domain,
                  generation: account.verifierSetAt
                })
                return customs.reset(account.email)
              }
            )
            .then(
              function () {
                return password.unwrap(account.wrapWrapKb)
              }
            )
            .then(
              function (wrapKbData) {
                wrapKb = wrapKbData
              }
            )
        }

        function createSessionToken () {
          if (hasSessionToken) {
            // Create a sessionToken so that the client does
            // not have to re-login
            var sessionTokenOptions = {
              uid: account.uid,
              email: account.email,
              emailCode: account.emailCode,
              emailVerified: account.emailVerified,
              verifierSetAt: account.verifierSetAt
            }

            return db.createSessionToken(sessionTokenOptions, request.headers['user-agent'])
              .then(
                function (result) {
                  sessionToken = result
                }
              )
          }
        }

        function createKeyFetchToken () {
          if (requestHelper.wantsKeys(request)) {
            if (!hasSessionToken) {
              // Sanity-check: any client requesting keys,
              // should also be requesting a sessionToken.
              throw error.missingRequestParameter('sessionToken')
            }
            return db.createKeyFetchToken({
                uid: account.uid,
                kA: account.kA,
                wrapKb: wrapKb,
                emailVerified: account.emailVerified
              })
              .then(
                function (result) {
                  keyFetchToken = result
                }
              )
          }
        }

        function createResponse () {
          // If no sessionToken, this could be a legacy client
          // attempting to reset an account password, return legacy response.
          if (!hasSessionToken) {
            return {}
          }

          var response = {
            uid: sessionToken.uid.toString('hex'),
            sessionToken: sessionToken.data.toString('hex'),
            verified: sessionToken.emailVerified,
            authAt: sessionToken.lastAuthAt()
          }

          if (requestHelper.wantsKeys(request)) {
            response.keyFetchToken = keyFetchToken.data.toString('hex')
          }

          return response
        }
      }
    },
    {
      method: 'POST',
      path: '/account/destroy',
      config: {
        validate: {
          payload: {
            email: validators.email().required(),
            authPW: isA.string().min(64).max(64).regex(HEX_STRING).required()
          }
        }
      },
      handler: function accountDestroy(request, reply) {
        log.begin('Account.destroy', request)
        var form = request.payload
        var authPW = Buffer(form.authPW, 'hex')
        customs.check(
          request.app.clientAddress,
          form.email,
          'accountDestroy')
          .then(db.emailRecord.bind(db, form.email))
          .then(
            function (emailRecord) {
              if (emailRecord.lockedAt) {
                throw error.lockedAccount()
              }

              return checkPassword(emailRecord, authPW, request.app.clientAddress)
                .then(
                  function (match) {
                    if (!match) {
                      throw error.incorrectPassword(emailRecord.email, form.email)
                    }
                    return db.deleteAccount(emailRecord)
                  }
                )
                .then(
                  function () {
                    log.event('delete', request, {
                      uid: emailRecord.uid.toString('hex') + '@' + config.domain
                    })
                    return {}
                  }
                )
            },
            function (err) {
              if (err.errno === error.ERRNO.ACCOUNT_UNKNOWN) {
                customs.flag(request.app.clientAddress, {
                  email: form.email,
                  errno: err.errno
                })
              }
              throw err
            }
          )
          .done(reply, reply)
      }
    }
  ]

  if (config.isProduction) {
    delete routes[0].config.validate.payload.preVerified
  } else {
    // programmatic account lockout is only available in non-production mode.
    routes.push({
      method: 'POST',
      path: '/account/lock',
      config: {
        validate: {
          payload: {
            email: validators.email().required(),
            authPW: isA.string().min(64).max(64).regex(HEX_STRING).required()
          }
        }
      },
      handler: function (request, reply) {
        log.begin('Account.lock', request)
        var form = request.payload
        var email = form.email
        var authPW = Buffer(form.authPW, 'hex')

        customs.check(
          request.app.clientAddress,
          email,
          'accountLock')
          .then(db.emailRecord.bind(db, email))
          .then(
            function (emailRecord) {
              // The account is already locked, silently succeed.
              if (emailRecord.lockedAt) {
                return true
              }
              return checkPassword(emailRecord, authPW, request.app.clientAddress)
              .then(
                function (match) {
                  // a bit of a strange one, only lock the account if the
                  // password matches, otherwise let customs handle any account
                  // lock.
                  if (! match) {
                    throw error.incorrectPassword(emailRecord.email, email)
                  }
                  log.info({
                    op: 'account.lock',
                    email: emailRecord.email,
                    uid: emailRecord.uid.toString('hex')
                  })
                  return db.lockAccount(emailRecord)
                }
              )
            }
          )
          .done(
            function () {
              reply({})
            },
            reply
          )
      }
    })
  }

  return routes
}

