const taskcluster = require('taskcluster-client');
const { scopeIntersection } = require('taskcluster-lib-scopes');
const oauth2orize = require('oauth2orize');
const _ = require('lodash');
const WebServerError = require('../utils/WebServerError');
const tryCatch = require('../utils/tryCatch');
const ensureLoggedIn = require('../utils/ensureLoggedIn');
const expressWrapAsync = require('../utils/expressWrapAsync');

module.exports = (cfg, AuthorizationCode, AccessToken, strategies, auth, monitor) => {
  // Create OAuth 2.0 server
  const server = oauth2orize.createServer();

  server.serializeClient((client, done) => done(null, client));
  server.deserializeClient((client, done) => done(null, client));

  function findRegisteredClient(clientId) {
    return cfg.login.registeredClients.find(client => client.clientId === clientId);
  }

  /**
   * Grant implicit authorization.
   *
   * The callback takes the `client` requesting authorization, the authenticated
   * `user` granting access, and their response, which contains approved scope,
   * duration, etc. as parsed by the application.  The application issues a token,
   * which is bound to these values.
   */
  server.grant(oauth2orize.grant.token(async (client, user, ares, areq, done) => {
    if (!_.isEqual(client.scope.sort(), areq.scope.sort())) {
      return done(new oauth2orize.AuthorizationError(null, 'invalid_scope'));
    }

    if (!client) {
      return done(new oauth2orize.AuthorizationError(null, 'unauthorized_client'));
    }

    if (!client.redirectUri.some(uri => uri === areq.redirectURI)) {
      return done(new oauth2orize.AuthorizationError(null, 'access_denied'));
    }

    if (client.responseType !== 'token') {
      return done(new oauth2orize.AuthorizationError(null, 'unsupported_response_type'));
    }

    // The access token we give to third parties
    const accessToken = new Buffer.from(taskcluster.slugid()).toString('base64');
    const currentUser = await strategies[user.identityProviderId].userFromIdentity(user.identity);

    await AccessToken.create({
      // OAuth2 client
      clientId: client.clientId,
      redirectUri: areq.redirectURI,
      identity: user.identity,
      identityProviderId: user.identityProviderId,
      accessToken: accessToken,
      expires: taskcluster.fromNow('10 minutes'),
      clientDetails: {
        clientId: `${user.identity}/${client.clientId}-${taskcluster.slugid().slice(0, 6)}`,
        description: ares.description || `Client generated by ${user.identity} for OAuth2 Client ${client.clientId}`,
        scopes: scopeIntersection(ares.scope, currentUser.scopes()),
        expires: ares.expires ?
          ares.expires > taskcluster.fromNow(client.maxExpires) ?
            taskcluster.fromNow(client.maxExpires).toISOString() :
            ares.expires.toISOString()
          : taskcluster.fromNow(client.maxExpires).toISOString(),
        deleteOnExpiration: true,
      },
    }, true);

    return done(null, accessToken);
  }));

  /**
   * Grant authorization codes
   *
   * The callback takes the `client` requesting authorization, the `redirectURI`
   * (which is used as a verifier in the subsequent exchange), the authenticated
   * `user` granting access, and their response, which contains approved scope,
   * duration, etc. as parsed by the application.  The application issues a code,
   * which is bound to these values, and will be exchanged for an access token.
   */
  server.grant(oauth2orize.grant.code(async (client, redirectURI, user, ares, areq, done) => {
    const code = taskcluster.slugid();

    if (!_.isEqual(client.scope.sort(), areq.scope.sort())) {
      return done(new oauth2orize.AuthorizationError(null, 'invalid_scope'));
    }

    if (!client) {
      return done(new oauth2orize.AuthorizationError(null, 'unauthorized_client'));
    }

    if (!client.redirectUri.some(uri => uri === redirectURI)) {
      return done(new oauth2orize.AuthorizationError(null, 'access_denied'));
    }

    if (client.responseType !== 'code') {
      return done(new oauth2orize.AuthorizationError(null, 'unsupported_response_type'));
    }

    const currentUser = await strategies[user.identityProviderId].userFromIdentity(user.identity);

    await AuthorizationCode.create({
      code,
      // OAuth2 client
      clientId: client.clientId,
      redirectUri: redirectURI,
      identity: user.identity,
      identityProviderId: user.identityProviderId,
      // The access token we give to third parties
      accessToken: new Buffer.from(taskcluster.slugid()).toString('base64'),
      // A maximum of 10 minutes is recommended in https://tools.ietf.org/html/rfc6749#section-4.1.2
      expires: taskcluster.fromNow('10 minutes'),
      clientDetails: {
        clientId: `${user.identity}/${client.clientId}-${taskcluster.slugid().slice(0, 6)}`,
        description: `Client generated by ${user.identity} for OAuth2 Client ${client.clientId}`,
        scopes: scopeIntersection(ares.scope, currentUser.scopes()),
        expires: ares.expires ?
          ares.expires > taskcluster.fromNow(client.maxExpires) ?
            taskcluster.fromNow(client.maxExpires).toISOString() :
            ares.expires.toISOString()
          : taskcluster.fromNow(client.maxExpires).toISOString(),
        deleteOnExpiration: true,
      },
    }, true);

    return done(null, code);
  }));

  /**
   * After a client has obtained an authorization grant from the user,
   * we exchange the authorization code for an access token.
   *
   * The callback accepts the `client`, which is exchanging `code` and any
   * `redirectURI` from the authorization request for verification.  If these values
   * are validated, the application issues a Taskcluster token on behalf of the user who
   * authorized the code.
   */
  server.exchange(oauth2orize.exchange.code(async (client, code, redirectURI, done) => {
    const entry = await AuthorizationCode.load({ code }, true);

    if (!entry) {
      return done(null, false);
    }

    if (redirectURI !== entry.redirectUri) {
      return done(null, false);
    }

    await AccessToken.create({
      // OAuth2 client
      clientId: entry.clientId,
      redirectUri: redirectURI,
      identity: entry.identity,
      identityProviderId: entry.identityProviderId,
      accessToken: entry.accessToken,
      // This table is used alongside the AuthorizationCode table which has a 10 minute recommended expiration
      expires: taskcluster.fromNow('10 minutes'),
      clientDetails: entry.clientDetails,
    }, true);

    return done(null, entry.accessToken);
  }));

  const authorization = [
    ensureLoggedIn,
    server.authorization((clientID, redirectURI, scope, done) => {
      const client = findRegisteredClient(clientID);

      if (!client) {
        return done(null, false);
      }

      if (!client.redirectUri.some(uri => uri === redirectURI)) {
        return done(null, false);
      }

      return done(null, client, redirectURI);
    }, async (client, user, scope, done) => {
      // Skip consent form if the client is whitelisted
      if (client.whitelisted && user && _.isEqual(client.scope.sort(), scope.sort())) {
        // Resetting the access token is the default behavior for whitelisted clients.
        // One less click in the UI.
        await auth.resetAccessToken(user.identity);

        return done(null, true, { scope });
      }

      return done(null, false);
    }),
    (req, res) => {
      const client = findRegisteredClient(req.query.client_id);
      let expires = client.maxExpires;

      if (req.query.expires) {
        try {
          if (new Date(taskcluster.fromNow(req.query.expires)) > new Date(taskcluster.fromNow(client.maxExpires))) {
            expires = client.maxExpires;
          } else {
            expires = req.query.expires;
          }
        } catch (e) {
          // req.query.expires was probably an invalid date.
          // We default to the max expiration time defined by the client.
        }
      }

      const query = new URLSearchParams({
        transactionID: req.oauth2.transactionID,
        client_id: req.query.client_id,
        expires,
        scope: req.query.scope,
      });

      res.redirect(`${cfg.app.publicUrl}/third-party?${query}`);
    },
    server.errorHandler({ mode: 'indirect' }),
  ];

  const decision = [
    ensureLoggedIn,
    server.decision((req, done) => {
      const { scope, description, expires } = req.body;

      return done(null, {
        scope: scope ? scope.split(' ') : [],
        description,
        expires: new Date(expires),
      });
    }),
    server.errorHandler({ mode: 'indirect' }),
  ];

  /**
   * Token endpoint
   *
   * `token` middleware handles client requests to exchange
   * an authorization code for a Taskcluster token.
   */
  const token = [
    server.token(),
    server.errorHandler(),
  ];

  /**
   * Credential endpoint - Resource server
   *
   * The Taskcluster deployment acts as a "resource server" by serving Taskcluster
   * credentials given a valid OAuth2 access token.
   *
   * This is accomplished by calling the endpoint <root-url>/login/oauth/credentials with the header
   *    Authorization: Bearer <access-token>
   *
   * The response is a JSON body of the form:
   *
   * {
   *   "credentials": {
   *     "clientId": "...",
   *     "accessToken": "...",
   *   },
   *   "expires": "..."
   * }
   *
   *
   */
  const getCredentials = expressWrapAsync(async (req, res) => {
    // Don't report much to the user, to avoid revealing sensitive information, although
    // it is likely in the service logs.
    const inputError = new WebServerError('InputError', 'Could not generate credentials for this access token');
    const entry = await AccessToken.load({ accessToken: req.accessToken }, true);

    if (!entry) {
      throw inputError;
    }

    // Although we eventually delete expired rows, that only happens once per day
    // so we need to check that the accessToken is not expired.
    if (new Date(entry.clientDetails.expires) < new Date()) {
      throw inputError;
    }

    const { clientId, ...data } = entry.clientDetails;

    // Create permacreds to give admins the ability to audit and revoke
    // the access at any time and that the client scanner process will
    // automatically disable any clients that have too many scopes
    const [clientError, client] = await tryCatch(auth.createClient(clientId, {
      ...data,
      expires: new Date(data.expires),
    }));

    if (clientError) {
      throw inputError;
    }

    // Move expires back by 30 seconds to ensure the user refreshes well in advance of the
    // actual credential expiration time
    client.expires.setSeconds(client.expires.getSeconds() - 30);

    monitor.log.createCredentials({
      clientId: client.clientId,
      expires: client.expires,
      userIdentity: req.user.identity,
    });

    res.send({
      expires: client.expires,
      credentials: {
        clientId: client.clientId,
        accessToken: client.accessToken,
      },
    });
  });

  return {
    authorization,
    decision,
    token,
    getCredentials,
  };
};
