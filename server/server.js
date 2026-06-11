(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory(require('http'), require('fs'), require('crypto')) :
        typeof define === 'function' && define.amd ? define(['http', 'fs', 'crypto'], factory) :
            (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.Server = factory(global.http, global.fs, global.crypto));
}(this, (function (http, fs, crypto) {
    'use strict';

    function _interopDefaultLegacy(e) { return e && typeof e === 'object' && 'default' in e ? e : { 'default': e }; }

    var http__default = /*#__PURE__*/_interopDefaultLegacy(http);
    var fs__default = /*#__PURE__*/_interopDefaultLegacy(fs);
    var crypto__default = /*#__PURE__*/_interopDefaultLegacy(crypto);

    class ServiceError extends Error {
        constructor(message = 'Service Error') {
            super(message);
            this.name = 'ServiceError';
        }
    }

    class NotFoundError extends ServiceError {
        constructor(message = 'Resource not found') {
            super(message);
            this.name = 'NotFoundError';
            this.status = 404;
        }
    }

    class RequestError extends ServiceError {
        constructor(message = 'Request error') {
            super(message);
            this.name = 'RequestError';
            this.status = 400;
        }
    }

    class ConflictError extends ServiceError {
        constructor(message = 'Resource conflict') {
            super(message);
            this.name = 'ConflictError';
            this.status = 409;
        }
    }

    class AuthorizationError extends ServiceError {
        constructor(message = 'Unauthorized') {
            super(message);
            this.name = 'AuthorizationError';
            this.status = 401;
        }
    }

    class CredentialError extends ServiceError {
        constructor(message = 'Forbidden') {
            super(message);
            this.name = 'CredentialError';
            this.status = 403;
        }
    }

    var errors = {
        ServiceError,
        NotFoundError,
        RequestError,
        ConflictError,
        AuthorizationError,
        CredentialError
    };

    const { ServiceError: ServiceError$1 } = errors;


    function createHandler(plugins, services) {
        return async function handler(req, res) {
            const method = req.method;
            console.info(`<< ${req.method} ${req.url}`);

            // Redirect fix for admin panel relative paths
            if (req.url.slice(-6) == '/admin') {
                res.writeHead(302, {
                    'Location': `http://${req.headers.host}/admin/`
                });
                return res.end();
            }

            let status = 200;
            let headers = {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            };
            let result = '';
            let context;

            // NOTE: the OPTIONS method results in undefined result and also it never processes plugins - keep this in mind
            if (method == 'OPTIONS') {
                Object.assign(headers, {
                    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
                    'Access-Control-Allow-Credentials': false,
                    'Access-Control-Max-Age': '86400',
                    'Access-Control-Allow-Headers': 'X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept, X-Authorization, X-Admin'
                });
            } else {
                try {
                    context = processPlugins();
                    await handle(context);
                } catch (err) {
                    if (err instanceof ServiceError$1) {
                        status = err.status || 400;
                        result = composeErrorObject(err.code || status, err.message);
                    } else {
                        // Unhandled exception, this is due to an error in the service code - REST consumers should never have to encounter this;
                        // If it happens, it must be debugged in a future version of the server
                        console.error(err);
                        status = 500;
                        result = composeErrorObject(500, 'Server Error');
                    }
                }
            }

            res.writeHead(status, headers);
            if (context != undefined && context.util != undefined && context.util.throttle) {
                await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
            }
            res.end(result);

            function processPlugins() {
                const context = { params: {} };
                plugins.forEach(decorate => decorate(context, req));
                return context;
            }

            async function handle(context) {
                const { serviceName, tokens, query, body } = await parseRequest(req);
                if (serviceName == 'admin') {
                    return ({ headers, result } = services['admin'](method, tokens, query, body));
                } else if (serviceName == 'favicon.ico') {
                    return ({ headers, result } = services['favicon'](method, tokens, query, body));
                }

                const service = services[serviceName];

                if (service === undefined) {
                    status = 400;
                    result = composeErrorObject(400, `Service "${serviceName}" is not supported`);
                    console.error('Missing service ' + serviceName);
                } else {
                    result = await service(context, { method, tokens, query, body });
                }

                // NOTE: logout does not return a result
                // in this case the content type header should be omitted, to allow checks on the client
                if (result !== undefined) {
                    result = JSON.stringify(result);
                } else {
                    status = 204;
                    delete headers['Content-Type'];
                }
            }
        };
    }



    function composeErrorObject(code, message) {
        return JSON.stringify({
            code,
            message
        });
    }

    async function parseRequest(req) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const tokens = url.pathname.split('/').filter(x => x.length > 0);
        const serviceName = tokens.shift();
        const queryString = url.search.split('?')[1] || '';
        const query = queryString
            .split('&')
            .filter(s => s != '')
            .map(x => x.split('='))
            .reduce((p, [k, v]) => Object.assign(p, { [k]: decodeURIComponent(v.replace(/\+/g, " ")) }), {});

        let body;
        // If req stream has ended body has been parsed
        if (req.readableEnded) {
            body = req.body;
        } else {
            body = await parseBody(req);
        }

        return {
            serviceName,
            tokens,
            query,
            body
        };
    }

    function parseBody(req) {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', (chunk) => body += chunk.toString());
            req.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    resolve(body);
                }
            });
        });
    }

    var requestHandler = createHandler;

    class Service {
        constructor() {
            this._actions = [];
            this.parseRequest = this.parseRequest.bind(this);
        }

        /**
         * Handle service request, after it has been processed by a request handler
         * @param {*} context Execution context, contains result of middleware processing
         * @param {{method: string, tokens: string[], query: *, body: *}} request Request parameters
         */
        async parseRequest(context, request) {
            for (let { method, name, handler } of this._actions) {
                if (method === request.method && matchAndAssignParams(context, request.tokens[0], name)) {
                    return await handler(context, request.tokens.slice(1), request.query, request.body);
                }
            }
        }

        /**
         * Register service action
         * @param {string} method HTTP method
         * @param {string} name Action name. Can be a glob pattern.
         * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
         */
        registerAction(method, name, handler) {
            this._actions.push({ method, name, handler });
        }

        /**
         * Register GET action
         * @param {string} name Action name. Can be a glob pattern.
         * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
         */
        get(name, handler) {
            this.registerAction('GET', name, handler);
        }

        /**
         * Register POST action
         * @param {string} name Action name. Can be a glob pattern.
         * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
         */
        post(name, handler) {
            this.registerAction('POST', name, handler);
        }

        /**
         * Register PUT action
         * @param {string} name Action name. Can be a glob pattern.
         * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
         */
        put(name, handler) {
            this.registerAction('PUT', name, handler);
        }

        /**
         * Register PATCH action
         * @param {string} name Action name. Can be a glob pattern.
         * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
         */
        patch(name, handler) {
            this.registerAction('PATCH', name, handler);
        }

        /**
         * Register DELETE action
         * @param {string} name Action name. Can be a glob pattern.
         * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
         */
        delete(name, handler) {
            this.registerAction('DELETE', name, handler);
        }
    }

    function matchAndAssignParams(context, name, pattern) {
        if (pattern == '*') {
            return true;
        } else if (pattern[0] == ':') {
            context.params[pattern.slice(1)] = name;
            return true;
        } else if (name == pattern) {
            return true;
        } else {
            return false;
        }
    }

    var Service_1 = Service;

    function uuid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            let r = Math.random() * 16 | 0,
                v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    var util = {
        uuid
    };

    const uuid$1 = util.uuid;


    const data = fs__default['default'].existsSync('./data') ? fs__default['default'].readdirSync('./data').reduce((p, c) => {
        const content = JSON.parse(fs__default['default'].readFileSync('./data/' + c));
        const collection = c.slice(0, -5);
        p[collection] = {};
        for (let endpoint in content) {
            p[collection][endpoint] = content[endpoint];
        }
        return p;
    }, {}) : {};

    const actions = {
        get: (context, tokens, query, body) => {
            tokens = [context.params.collection, ...tokens];
            let responseData = data;
            for (let token of tokens) {
                if (responseData !== undefined) {
                    responseData = responseData[token];
                }
            }
            return responseData;
        },
        post: (context, tokens, query, body) => {
            tokens = [context.params.collection, ...tokens];
            console.log('Request body:\n', body);

            // TODO handle collisions, replacement
            let responseData = data;
            for (let token of tokens) {
                if (responseData.hasOwnProperty(token) == false) {
                    responseData[token] = {};
                }
                responseData = responseData[token];
            }

            const newId = uuid$1();
            responseData[newId] = Object.assign({}, body, { _id: newId });
            return responseData[newId];
        },
        put: (context, tokens, query, body) => {
            tokens = [context.params.collection, ...tokens];
            console.log('Request body:\n', body);

            let responseData = data;
            for (let token of tokens.slice(0, -1)) {
                if (responseData !== undefined) {
                    responseData = responseData[token];
                }
            }
            if (responseData !== undefined && responseData[tokens.slice(-1)] !== undefined) {
                responseData[tokens.slice(-1)] = body;
            }
            return responseData[tokens.slice(-1)];
        },
        patch: (context, tokens, query, body) => {
            tokens = [context.params.collection, ...tokens];
            console.log('Request body:\n', body);

            let responseData = data;
            for (let token of tokens) {
                if (responseData !== undefined) {
                    responseData = responseData[token];
                }
            }
            if (responseData !== undefined) {
                Object.assign(responseData, body);
            }
            return responseData;
        },
        delete: (context, tokens, query, body) => {
            tokens = [context.params.collection, ...tokens];
            let responseData = data;

            for (let i = 0; i < tokens.length; i++) {
                const token = tokens[i];
                if (responseData.hasOwnProperty(token) == false) {
                    return null;
                }
                if (i == tokens.length - 1) {
                    const body = responseData[token];
                    delete responseData[token];
                    return body;
                } else {
                    responseData = responseData[token];
                }
            }
        }
    };

    const dataService = new Service_1();
    dataService.get(':collection', actions.get);
    dataService.post(':collection', actions.post);
    dataService.put(':collection', actions.put);
    dataService.patch(':collection', actions.patch);
    dataService.delete(':collection', actions.delete);


    var jsonstore = dataService.parseRequest;

    /*
     * This service requires storage and auth plugins
     */

    const { AuthorizationError: AuthorizationError$1 } = errors;



    const userService = new Service_1();

    userService.get('me', getSelf);
    userService.post('register', onRegister);
    userService.post('login', onLogin);
    userService.get('logout', onLogout);


    function getSelf(context, tokens, query, body) {
        if (context.user) {
            const result = Object.assign({}, context.user);
            delete result.hashedPassword;
            return result;
        } else {
            throw new AuthorizationError$1();
        }
    }

    function onRegister(context, tokens, query, body) {
        return context.auth.register(body);
    }

    function onLogin(context, tokens, query, body) {
        return context.auth.login(body);
    }

    function onLogout(context, tokens, query, body) {
        return context.auth.logout();
    }

    var users = userService.parseRequest;

    const { NotFoundError: NotFoundError$1, RequestError: RequestError$1 } = errors;


    var crud = {
        get,
        post,
        put,
        patch,
        delete: del
    };


    function validateRequest(context, tokens, query) {
        /*
        if (context.params.collection == undefined) {
            throw new RequestError('Please, specify collection name');
        }
        */
        if (tokens.length > 1) {
            throw new RequestError$1();
        }
    }

    function parseWhere(query) {
        const operators = {
            '<=': (prop, value) => record => record[prop] <= JSON.parse(value),
            '<': (prop, value) => record => record[prop] < JSON.parse(value),
            '>=': (prop, value) => record => record[prop] >= JSON.parse(value),
            '>': (prop, value) => record => record[prop] > JSON.parse(value),
            '=': (prop, value) => record => record[prop] == JSON.parse(value),
            ' like ': (prop, value) => record => record[prop].toLowerCase().includes(JSON.parse(value).toLowerCase()),
            ' in ': (prop, value) => record => JSON.parse(`[${/\((.+?)\)/.exec(value)[1]}]`).includes(record[prop]),
        };
        const pattern = new RegExp(`^(.+?)(${Object.keys(operators).join('|')})(.+?)$`, 'i');

        try {
            let clauses = [query.trim()];
            let check = (a, b) => b;
            let acc = true;
            if (query.match(/ and /gi)) {
                // inclusive
                clauses = query.split(/ and /gi);
                check = (a, b) => a && b;
                acc = true;
            } else if (query.match(/ or /gi)) {
                // optional
                clauses = query.split(/ or /gi);
                check = (a, b) => a || b;
                acc = false;
            }
            clauses = clauses.map(createChecker);

            return (record) => clauses
                .map(c => c(record))
                .reduce(check, acc);
        } catch (err) {
            throw new Error('Could not parse WHERE clause, check your syntax.');
        }

        function createChecker(clause) {
            let [match, prop, operator, value] = pattern.exec(clause);
            [prop, value] = [prop.trim(), value.trim()];

            return operators[operator.toLowerCase()](prop, value);
        }
    }


    function get(context, tokens, query, body) {
        validateRequest(context, tokens);

        let responseData;

        try {
            if (query.where) {
                responseData = context.storage.get(context.params.collection).filter(parseWhere(query.where));
            } else if (context.params.collection) {
                responseData = context.storage.get(context.params.collection, tokens[0]);
            } else {
                // Get list of collections
                return context.storage.get();
            }

            if (query.sortBy) {
                const props = query.sortBy
                    .split(',')
                    .filter(p => p != '')
                    .map(p => p.split(' ').filter(p => p != ''))
                    .map(([p, desc]) => ({ prop: p, desc: desc ? true : false }));

                // Sorting priority is from first to last, therefore we sort from last to first
                for (let i = props.length - 1; i >= 0; i--) {
                    let { prop, desc } = props[i];
                    responseData.sort(({ [prop]: propA }, { [prop]: propB }) => {
                        if (typeof propA == 'number' && typeof propB == 'number') {
                            return (propA - propB) * (desc ? -1 : 1);
                        } else {
                            return propA.localeCompare(propB) * (desc ? -1 : 1);
                        }
                    });
                }
            }

            if (query.offset) {
                responseData = responseData.slice(Number(query.offset) || 0);
            }
            const pageSize = Number(query.pageSize) || 10;
            if (query.pageSize) {
                responseData = responseData.slice(0, pageSize);
            }

            if (query.distinct) {
                const props = query.distinct.split(',').filter(p => p != '');
                responseData = Object.values(responseData.reduce((distinct, c) => {
                    const key = props.map(p => c[p]).join('::');
                    if (distinct.hasOwnProperty(key) == false) {
                        distinct[key] = c;
                    }
                    return distinct;
                }, {}));
            }

            if (query.count) {
                return responseData.length;
            }

            if (query.select) {
                const props = query.select.split(',').filter(p => p != '');
                responseData = Array.isArray(responseData) ? responseData.map(transform) : transform(responseData);

                function transform(r) {
                    const result = {};
                    props.forEach(p => result[p] = r[p]);
                    return result;
                }
            }

            if (query.load) {
                const props = query.load.split(',').filter(p => p != '');
                props.map(prop => {
                    const [propName, relationTokens] = prop.split('=');
                    const [idSource, collection] = relationTokens.split(':');
                    console.log(`Loading related records from "${collection}" into "${propName}", joined on "_id"="${idSource}"`);
                    const storageSource = collection == 'users' ? context.protectedStorage : context.storage;
                    responseData = Array.isArray(responseData) ? responseData.map(transform) : transform(responseData);

                    function transform(r) {
                        const seekId = r[idSource];
                        const related = storageSource.get(collection, seekId);
                        delete related.hashedPassword;
                        r[propName] = related;
                        return r;
                    }
                });
            }

        } catch (err) {
            console.error(err);
            if (err.message.includes('does not exist')) {
                throw new NotFoundError$1();
            } else {
                throw new RequestError$1(err.message);
            }
        }

        context.canAccess(responseData);

        return responseData;
    }

    function post(context, tokens, query, body) {
        console.log('Request body:\n', body);

        validateRequest(context, tokens);
        if (tokens.length > 0) {
            throw new RequestError$1('Use PUT to update records');
        }
        context.canAccess(undefined, body);

        body._ownerId = context.user._id;
        let responseData;

        try {
            responseData = context.storage.add(context.params.collection, body);
        } catch (err) {
            throw new RequestError$1();
        }

        return responseData;
    }

    function put(context, tokens, query, body) {
        console.log('Request body:\n', body);

        validateRequest(context, tokens);
        if (tokens.length != 1) {
            throw new RequestError$1('Missing entry ID');
        }

        let responseData;
        let existing;

        try {
            existing = context.storage.get(context.params.collection, tokens[0]);
        } catch (err) {
            throw new NotFoundError$1();
        }

        context.canAccess(existing, body);

        try {
            responseData = context.storage.set(context.params.collection, tokens[0], body);
        } catch (err) {
            throw new RequestError$1();
        }

        return responseData;
    }

    function patch(context, tokens, query, body) {
        console.log('Request body:\n', body);

        validateRequest(context, tokens);
        if (tokens.length != 1) {
            throw new RequestError$1('Missing entry ID');
        }

        let responseData;
        let existing;

        try {
            existing = context.storage.get(context.params.collection, tokens[0]);
        } catch (err) {
            throw new NotFoundError$1();
        }

        context.canAccess(existing, body);

        try {
            responseData = context.storage.merge(context.params.collection, tokens[0], body);
        } catch (err) {
            throw new RequestError$1();
        }

        return responseData;
    }

    function del(context, tokens, query, body) {
        validateRequest(context, tokens);
        if (tokens.length != 1) {
            throw new RequestError$1('Missing entry ID');
        }

        let responseData;
        let existing;

        try {
            existing = context.storage.get(context.params.collection, tokens[0]);
        } catch (err) {
            throw new NotFoundError$1();
        }

        context.canAccess(existing);

        try {
            responseData = context.storage.delete(context.params.collection, tokens[0]);
        } catch (err) {
            throw new RequestError$1();
        }

        return responseData;
    }

    /*
     * This service requires storage and auth plugins
     */

    const dataService$1 = new Service_1();
    dataService$1.get(':collection', crud.get);
    dataService$1.post(':collection', crud.post);
    dataService$1.put(':collection', crud.put);
    dataService$1.patch(':collection', crud.patch);
    dataService$1.delete(':collection', crud.delete);

    var data$1 = dataService$1.parseRequest;

    const imgdata = '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Td4DLneAwSddMiRH8tMU8nng/Yy+KQsM3AKBNbe35j5OH4A0dbV8AxwcAqMFyl73eHd3e2//nmn29wOGi3Kv+RixSgAAEkxpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+Cjx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IlhNUCBDb3JlIDQuNC4wLUV4aXYyIj4KIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIKICAgIHhtbG5zOmlwdGNFeHQ9Imh0dHA6Ly9pcHRjLm9yZy9zdGQvSXB0YzR4bXBFeHQvMjAwOC0wMi0yOS8iCiAgICB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIKICAgIHhtbG5zOnN0RXZ0PSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VFdmVudCMiCiAgICB4bWxuczpwbHVzPSJodHRwOi8vbnMudXNlcGx1cy5vcmcvbGRmL3htcC8xLjAvIgogICAgeG1sbnM6R0lNUD0iaHR0cDovL3d3dy5naW1wLm9yZy94bXAvIgogICAgeG1sbnM6ZGM9Imh0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvIgogICAgeG1sbnM6cGhvdG9zaG9wPSJodHRwOi8vbnMuYWRvYmUuY29tL3Bob3Rvc2hvcC8xLjAvIgogICAgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIgogICAgeG1sbnM6eG1wUmlnaHRzPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvcmlnaHRzLyIKICAgeG1wTU06RG9jdW1lbnRJRD0iZ2ltcDpkb2NpZDpnaW1wOjdjZDM3NWM3LTcwNmItNDlkMy1hOWRkLWNmM2Q3MmMwY2I4ZCIKICAgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDo2NGY2YTJlYy04ZjA5LTRkZTMtOTY3ZC05MTUyY2U5NjYxNTAiCiAgIHhtcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDoxMmE1NzI5Mi1kNmJkLTRlYjQtOGUxNi1hODEzYjMwZjU0NWYiCiAgIEdJTVA6QVBJPSIyLjAiCiAgIEdJTVA6UGxhdGZvcm09IldpbmRvd3MiCiAgIEdJTVA6VGltZVN0YW1wPSIxNjEzMzAwNzI5NTMwNjQzIgogICBHSU1QOlZlcnNpb249IjIuMTAuMTIiCiAgIGRjOkZvcm1hdD0iaW1hZ2UvcG5nIgogICBwaG90b3Nob3A6Q3JlZGl0PSJHZXR0eSBJbWFnZXMvaVN0b2NrcGhvdG8iCiAgIHhtcDpDcmVhdG9yVG9vbD0iR0lNUCAyLjEwIgogICB4bXBSaWdodHM6V2ViU3RhdGVtZW50PSJodHRwczovL3d3dy5pc3RvY2twaG90by5jb20vbGVnYWwvbGljZW5zZS1hZ3JlZW1lbnQ/dXRtX21lZGl1bT1vcmdhbmljJmFtcDt1dG1fc291cmNlPWdvb2dsZSZhbXA7dXRtX2NhbXBhaWduPWlwdGN1cmwiPgogICA8aXB0Y0V4dDpMb2NhdGlvbkNyZWF0ZWQ+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpMb2NhdGlvbkNyZWF0ZWQ+CiAgIDxpcHRjRXh0OkxvY2F0aW9uU2hvd24+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpMb2NhdGlvblNob3duPgogICA8aXB0Y0V4dDpBcnR3b3JrT3JPYmplY3Q+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpBcnR3b3JrT3JPYmplY3Q+CiAgIDxpcHRjRXh0OlJlZ2lzdHJ5SWQ+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpSZWdpc3RyeUlkPgogICA8eG1wTU06SGlzdG9yeT4KICAgIDxyZGY6U2VxPgogICAgIDxyZGY6bGkKICAgICAgc3RFdnQ6YWN0aW9uPSJzYXZlZCIKICAgICAgc3RFdnQ6Y2hhbmdlZD0iLyIKICAgICAgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDpjOTQ2M2MxMC05OWE4LTQ1NDQtYmRlOS1mNzY0ZjdhODJlZDkiCiAgICAgIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkdpbXAgMi4xMCAoV2luZG93cykiCiAgICAgIHN0RXZ0OndoZW49IjIwMjEtMDItMTRUMTM6MDU6MjkiLz4KICAgIDwvcmRmOlNlcT4KICAgPC94bXBNTTpIaXN0b3J5PgogICA8cGx1czpJbWFnZVN1cHBsaWVyPgogICAgPHJkZjpTZXEvPgogICA8L3BsdXM6SW1hZ2VTdXBwbGllcj4KICAgPHBsdXM6SW1hZ2VDcmVhdG9yPgogICAgPHJkZjpTZXEvPgogICA8L3BsdXM6SW1hZ2VDcmVhdG9yPgogICA8cGx1czpDb3B5cmlnaHRPd25lcj4KICAgIDxyZGY6U2VxLz4KICAgPC9wbHVzOkNvcHlyaWdodE93bmVyPgogICA8cGx1czpMaWNlbnNvcj4KICAgIDxyZGY6U2VxPgogICAgIDxyZGY6bGkKICAgICAgcGx1czpMaWNlbnNvclVSTD0iaHR0cHM6Ly93d3cuaXN0b2NrcGhvdG8uY29tL3Bob3RvL2xpY2Vuc2UtZ20xMTUwMzQ1MzQxLT91dG1fbWVkaXVtPW9yZ2FuaWMmYW1wO3V0bV9zb3VyY2U9Z29vZ2xlJmFtcDt1dG1fY2FtcGFpZ249aXB0Y3VybCIvPgogICAgPC9yZGY6U2VxPgogICA8L3BsdXM6TGljZW5zb3I+CiAgIDxkYzpjcmVhdG9yPgogICAgPHJkZjpTZXE+CiAgICAgPHJkZjpsaT5WbGFkeXNsYXYgU2VyZWRhPC9yZGY6bGk+CiAgICA8L3JkZjpTZXE+CiAgIDwvZGM6Y3JlYXRvcj4KICAgPGRjOmRlc2NyaXB0aW9uPgogICAgPHJkZjpBbHQ+CiAgICAgPHJkZjpsaSB4bWw6bGFuZz0ieC1kZWZhdWx0Ij5TZXJ2aWNlIHRvb2xzIGljb24gb24gd2hpdGUgYmFja2dyb3VuZC4gVmVjdG9yIGlsbHVzdHJhdGlvbi48L3JkZjpsaT4KICAgIDwvcmRmOkFsdD4KICAgPC9kYzpkZXNjcmlwdGlvbj4KICA8L3JkZjpEZXNjcmlwdGlvbj4KIDwvcmRmOlJERj4KPC94OnhtcG1ldGE+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAKPD94cGFja2V0IGVuZD0idyI/PmWJCnkAAAAGYktHRAD/AP8A/6C9p5MAAAAJcEhZcwAALiMAAC4jAXilP3YAAAAHdElNRQflAg4LBR0CZnO/AAAARHRFWHRDb21tZW50AFNlcnZpY2UgdG9vbHMgaWNvbiBvbiB3aGl0ZSBiYWNrZ3JvdW5kLiBWZWN0b3IgaWxsdXN0cmF0aW9uLlwvEeIAAAMxSURBVHja7Z1bcuQwCEX7qrLQXlp2ynxNVWbK7dgWj3sl9JvYRhxACD369erW7UMzx/cYaychonAQvXM5ABYkpynoYIiEGdoQog6AYfywBrCxF4zNrX/7McBbuXJe8rXx/KBDULcGsMREzCbeZ4J6ME/9wVH5d95rogZp3npEgPLP3m2iUSGqXBJS5Dr6hmLm8kRuZABYti5TMaailV8LodNQwTTUWk4/WZk75l0kM0aZQdaZjMqkrQDAuyMVJWFjMB4GANXr0lbZBxQKr7IjI7QvVWkok/Jn5UHVh61CYPs+/i7eL9j3y/Au8WqoAIC34k8/9k7N8miLcaGWHwgjZXE/awyYX7h41wKMCskZM2HXAddDkTdglpSjz5bcKPbcCEKwT3+DhxtVpJvkEC7rZSgq32NMSBoXaCdiahDCKrND0fpX8oQlVsQ8IFQZ1VARdIF5wroekAjB07gsAgDUIbQHFENIDEX4CQANIVe8Iw/ASiACLXl28eaf579OPuBa9/mrELUYHQ1t3KHlZZnRcXb2/c7ygXIQZqjDMEzeSrOgCAhqYMvTUE+FKXoVxTxgk3DEPREjGzj3nAk/VaKyB9GVIu4oMyOlrQZgrBBEFG9PAZTfs3amYDGrP9Wl964IeFvtz9JFluIvlEvcdoXDOdxggbDxGwTXcxFRi/LdirKgZUBm7SUdJG69IwSUzAMWgOAq/4hyrZVaJISSNWHFVbEoCFEhyBrCtXS9L+so9oTy8wGqxbQDD350WTjNESVFEB5hdKzUGcV5QtYxVWR2Ssl4Mg9qI9u6FCBInJRXgfEEgtS9Cgrg7kKouq4mdcDNBnEHQvWFTdgdgsqP+MiluVeBM13ahx09AYSWi50gsF+I6vn7BmCEoHR3NBzkpIOw4+XdVBBGQUioblaZHbGlodtB+N/jxqwLX/x/NARfD8ADxTOCKIcwE4Lw0OIbguMYcGTlymEpHYLXIKx8zQEqIfS2lGJPaADFEBR/PMH79ErqtpnZmTBlvM4wgihPWDEEhXn1LISj50crNgfCp+dWHYQRCfb2zgfnBZmKGAyi914anK9Coi4LOMhoAn3uVtn+AGnLKxPUZnCuAAAAAElFTkSuQmCC';
    const img = Buffer.from(imgdata, 'base64');

    var favicon = (method, tokens, query, body) => {
        console.log('serving favicon...');
        const headers = {
            'Content-Type': 'image/png',
            'Content-Length': img.length
        };
        let result = img;

        return {
            headers,
            result
        };
    };

    var require$$0 = "<!DOCTYPE html>\r\n<html lang=\"en\">\r\n<head>\r\n    <meta charset=\"UTF-8\">\r\n    <meta http-equiv=\"X-UA-Compatible\" content=\"IE=edge\">\r\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\r\n    <title>SUPS Admin Panel</title>\r\n    <style>\r\n        * {\r\n            padding: 0;\r\n            margin: 0;\r\n        }\r\n\r\n        body {\r\n            padding: 32px;\r\n            font-size: 16px;\r\n        }\r\n\r\n        .layout::after {\r\n            content: '';\r\n            clear: both;\r\n            display: table;\r\n        }\r\n\r\n        .col {\r\n            display: block;\r\n            float: left;\r\n        }\r\n\r\n        p {\r\n            padding: 8px 16px;\r\n        }\r\n\r\n        table {\r\n            border-collapse: collapse;\r\n        }\r\n\r\n        caption {\r\n            font-size: 120%;\r\n            text-align: left;\r\n            padding: 4px 8px;\r\n            font-weight: bold;\r\n            background-color: #ddd;\r\n        }\r\n\r\n        table, tr, th, td {\r\n            border: 1px solid #ddd;\r\n        }\r\n\r\n        th, td {\r\n            padding: 4px 8px;\r\n        }\r\n\r\n        ul {\r\n            list-style: none;\r\n        }\r\n\r\n        .collection-list a {\r\n            display: block;\r\n            width: 120px;\r\n            padding: 4px 8px;\r\n            text-decoration: none;\r\n            color: black;\r\n            background-color: #ccc;\r\n        }\r\n        .collection-list a:hover {\r\n            background-color: #ddd;\r\n        }\r\n        .collection-list a:visited {\r\n            color: black;\r\n        }\r\n    </style>\r\n    <script type=\"module\">\nimport { html, render } from 'https://unpkg.com/lit-html@1.3.0?module';\nimport { until } from 'https://unpkg.com/lit-html@1.3.0/directives/until?module';\n\nconst api = {\r\n    async get(url) {\r\n        return json(url);\r\n    },\r\n    async post(url, body) {\r\n        return json(url, {\r\n            method: 'POST',\r\n            headers: { 'Content-Type': 'application/json' },\r\n            body: JSON.stringify(body)\r\n        });\r\n    }\r\n};\r\n\r\nasync function json(url, options) {\r\n    return await (await fetch('/' + url, options)).json();\r\n}\r\n\r\nasync function getCollections() {\r\n    return api.get('data');\r\n}\r\n\r\nasync function getRecords(collection) {\r\n    return api.get('data/' + collection);\r\n}\r\n\r\nasync function getThrottling() {\r\n    return api.get('util/throttle');\r\n}\r\n\r\nasync function setThrottling(throttle) {\r\n    return api.post('util', { throttle });\r\n}\n\nasync function collectionList(onSelect) {\r\n    const collections = await getCollections();\r\n\r\n    return html`\r\n    <ul class=\"collection-list\">\r\n        ${collections.map(collectionLi)}\r\n    </ul>`;\r\n\r\n    function collectionLi(name) {\r\n        return html`<li><a href=\"javascript:void(0)\" @click=${(ev) => onSelect(ev, name)}>${name}</a></li>`;\r\n    }\r\n}\n\nasync function recordTable(collectionName) {\r\n    const records = await getRecords(collectionName);\r\n    const layout = getLayout(records);\r\n\r\n    return html`\r\n    <table>\r\n        <caption>${collectionName}</caption>\r\n        <thead>\r\n            <tr>${layout.map(f => html`<th>${f}</th>`)}</tr>\r\n        </thead>\r\n        <tbody>\r\n            ${records.map(r => recordRow(r, layout))}\r\n        </tbody>\r\n    </table>`;\r\n}\r\n\r\nfunction getLayout(records) {\r\n    const result = new Set(['_id']);\r\n    records.forEach(r => Object.keys(r).forEach(k => result.add(k)));\r\n\r\n    return [...result.keys()];\r\n}\r\n\r\nfunction recordRow(record, layout) {\r\n    return html`\r\n    <tr>\r\n        ${layout.map(f => html`<td>${JSON.stringify(record[f]) || html`<span>(missing)</span>`}</td>`)}\r\n    </tr>`;\r\n}\n\nasync function throttlePanel(display) {\r\n    const active = await getThrottling();\r\n\r\n    return html`\r\n    <p>\r\n        Request throttling: </span>${active}</span>\r\n        <button @click=${(ev) => set(ev, true)}>Enable</button>\r\n        <button @click=${(ev) => set(ev, false)}>Disable</button>\r\n    </p>`;\r\n\r\n    async function set(ev, state) {\r\n        ev.target.disabled = true;\r\n        await setThrottling(state);\r\n        display();\r\n    }\r\n}\n\n//import page from '//unpkg.com/page/page.mjs';\r\n\r\n\r\nfunction start() {\r\n    const main = document.querySelector('main');\r\n    editor(main);\r\n}\r\n\r\nasync function editor(main) {\r\n    let list = html`<div class=\"col\">Loading&hellip;</div>`;\r\n    let viewer = html`<div class=\"col\">\r\n    <p>Select collection to view records</p>\r\n</div>`;\r\n    display();\r\n\r\n    list = html`<div class=\"col\">${await collectionList(onSelect)}</div>`;\r\n    display();\r\n\r\n    async function display() {\r\n        render(html`\r\n        <section class=\"layout\">\r\n            ${until(throttlePanel(display), html`<p>Loading</p>`)}\r\n        </section>\r\n        <section class=\"layout\">\r\n            ${list}\r\n            ${viewer}\r\n        </section>`, main);\r\n    }\r\n\r\n    async function onSelect(ev, name) {\r\n        ev.preventDefault();\r\n        viewer = html`<div class=\"col\">${await recordTable(name)}</div>`;\r\n        display();\r\n    }\r\n}\r\n\r\nstart();\n\n</script>\r\n</head>\r\n<body>\r\n    <main>\r\n        Loading&hellip;\r\n    </main>\r\n</body>\r\n</html>";

    const mode = process.argv[2] == '-dev' ? 'dev' : 'prod';

    const files = {
        index: mode == 'prod' ? require$$0 : fs__default['default'].readFileSync('./client/index.html', 'utf-8')
    };

    var admin = (method, tokens, query, body) => {
        const headers = {
            'Content-Type': 'text/html'
        };
        let result = '';

        const resource = tokens.join('/');
        if (resource && resource.split('.').pop() == 'js') {
            headers['Content-Type'] = 'application/javascript';

            files[resource] = files[resource] || fs__default['default'].readFileSync('./client/' + resource, 'utf-8');
            result = files[resource];
        } else {
            result = files.index;
        }

        return {
            headers,
            result
        };
    };

    /*
     * This service requires util plugin
     */

    const utilService = new Service_1();

    utilService.post('*', onRequest);
    utilService.get(':service', getStatus);

    function getStatus(context, tokens, query, body) {
        return context.util[context.params.service];
    }

    function onRequest(context, tokens, query, body) {
        Object.entries(body).forEach(([k, v]) => {
            console.log(`${k} ${v ? 'enabled' : 'disabled'}`);
            context.util[k] = v;
        });
        return '';
    }

    var util$1 = utilService.parseRequest;

    var services = {
        jsonstore,
        users,
        data: data$1,
        favicon,
        admin,
        util: util$1
    };

    const { uuid: uuid$2 } = util;


    function initPlugin(settings) {
        const storage = createInstance(settings.seedData);
        const protectedStorage = createInstance(settings.protectedData);

        return function decoreateContext(context, request) {
            context.storage = storage;
            context.protectedStorage = protectedStorage;
        };
    }


    /**
     * Create storage instance and populate with seed data
     * @param {Object=} seedData Associative array with data. Each property is an object with properties in format {key: value}
     */
    function createInstance(seedData = {}) {
        const collections = new Map();

        // Initialize seed data from file    
        for (let collectionName in seedData) {
            if (seedData.hasOwnProperty(collectionName)) {
                const collection = new Map();
                for (let recordId in seedData[collectionName]) {
                    if (seedData.hasOwnProperty(collectionName)) {
                        collection.set(recordId, seedData[collectionName][recordId]);
                    }
                }
                collections.set(collectionName, collection);
            }
        }


        // Manipulation

        /**
         * Get entry by ID or list of all entries from collection or list of all collections
         * @param {string=} collection Name of collection to access. Throws error if not found. If omitted, returns list of all collections.
         * @param {number|string=} id ID of requested entry. Throws error if not found. If omitted, returns of list all entries in collection.
         * @return {Object} Matching entry.
         */
        function get(collection, id) {
            if (!collection) {
                return [...collections.keys()];
            }
            if (!collections.has(collection)) {
                throw new ReferenceError('Collection does not exist: ' + collection);
            }
            const targetCollection = collections.get(collection);
            if (!id) {
                const entries = [...targetCollection.entries()];
                let result = entries.map(([k, v]) => {
                    return Object.assign(deepCopy(v), { _id: k });
                });
                return result;
            }
            if (!targetCollection.has(id)) {
                throw new ReferenceError('Entry does not exist: ' + id);
            }
            const entry = targetCollection.get(id);
            return Object.assign(deepCopy(entry), { _id: id });
        }

        /**
         * Add new entry to collection. ID will be auto-generated
         * @param {string} collection Name of collection to access. If the collection does not exist, it will be created.
         * @param {Object} data Value to store.
         * @return {Object} Original value with resulting ID under _id property.
         */
        function add(collection, data) {
            const record = assignClean({ _ownerId: data._ownerId }, data);

            let targetCollection = collections.get(collection);
            if (!targetCollection) {
                targetCollection = new Map();
                collections.set(collection, targetCollection);
            }
            let id = uuid$2();
            // Make sure new ID does not match existing value
            while (targetCollection.has(id)) {
                id = uuid$2();
            }

            record._createdOn = Date.now();
            targetCollection.set(id, record);
            return Object.assign(deepCopy(record), { _id: id });
        }

        /**
         * Replace entry by ID
         * @param {string} collection Name of collection to access. Throws error if not found.
         * @param {number|string} id ID of entry to update. Throws error if not found.
         * @param {Object} data Value to store. Record will be replaced!
         * @return {Object} Updated entry.
         */
        function set(collection, id, data) {
            if (!collections.has(collection)) {
                throw new ReferenceError('Collection does not exist: ' + collection);
            }
            const targetCollection = collections.get(collection);
            if (!targetCollection.has(id)) {
                throw new ReferenceError('Entry does not exist: ' + id);
            }

            const existing = targetCollection.get(id);
            const record = assignSystemProps(deepCopy(data), existing);
            record._updatedOn = Date.now();
            targetCollection.set(id, record);
            return Object.assign(deepCopy(record), { _id: id });
        }

        /**
         * Modify entry by ID
         * @param {string} collection Name of collection to access. Throws error if not found.
         * @param {number|string} id ID of entry to update. Throws error if not found.
         * @param {Object} data Value to store. Shallow merge will be performed!
         * @return {Object} Updated entry.
         */
        function merge(collection, id, data) {
            if (!collections.has(collection)) {
                throw new ReferenceError('Collection does not exist: ' + collection);
            }
            const targetCollection = collections.get(collection);
            if (!targetCollection.has(id)) {
                throw new ReferenceError('Entry does not exist: ' + id);
            }

            const existing = deepCopy(targetCollection.get(id));
            const record = assignClean(existing, data);
            record._updatedOn = Date.now();
            targetCollection.set(id, record);
            return Object.assign(deepCopy(record), { _id: id });
        }

        /**
         * Delete entry by ID
         * @param {string} collection Name of collection to access. Throws error if not found.
         * @param {number|string} id ID of entry to update. Throws error if not found.
         * @return {{_deletedOn: number}} Server time of deletion.
         */
        function del(collection, id) {
            if (!collections.has(collection)) {
                throw new ReferenceError('Collection does not exist: ' + collection);
            }
            const targetCollection = collections.get(collection);
            if (!targetCollection.has(id)) {
                throw new ReferenceError('Entry does not exist: ' + id);
            }
            targetCollection.delete(id);

            return { _deletedOn: Date.now() };
        }

        /**
         * Search in collection by query object
         * @param {string} collection Name of collection to access. Throws error if not found.
         * @param {Object} query Query object. Format {prop: value}.
         * @return {Object[]} Array of matching entries.
         */
        function query(collection, query) {
            if (!collections.has(collection)) {
                throw new ReferenceError('Collection does not exist: ' + collection);
            }
            const targetCollection = collections.get(collection);
            const result = [];
            // Iterate entries of target collection and compare each property with the given query
            for (let [key, entry] of [...targetCollection.entries()]) {
                let match = true;
                for (let prop in entry) {
                    if (query.hasOwnProperty(prop)) {
                        const targetValue = query[prop];
                        // Perform lowercase search, if value is string
                        if (typeof targetValue === 'string' && typeof entry[prop] === 'string') {
                            if (targetValue.toLocaleLowerCase() !== entry[prop].toLocaleLowerCase()) {
                                match = false;
                                break;
                            }
                        } else if (targetValue != entry[prop]) {
                            match = false;
                            break;
                        }
                    }
                }

                if (match) {
                    result.push(Object.assign(deepCopy(entry), { _id: key }));
                }
            }

            return result;
        }

        return { get, add, set, merge, delete: del, query };
    }


    function assignSystemProps(target, entry, ...rest) {
        const whitelist = [
            '_id',
            '_createdOn',
            '_updatedOn',
            '_ownerId'
        ];
        for (let prop of whitelist) {
            if (entry.hasOwnProperty(prop)) {
                target[prop] = deepCopy(entry[prop]);
            }
        }
        if (rest.length > 0) {
            Object.assign(target, ...rest);
        }

        return target;
    }


    function assignClean(target, entry, ...rest) {
        const blacklist = [
            '_id',
            '_createdOn',
            '_updatedOn',
            '_ownerId'
        ];
        for (let key in entry) {
            if (blacklist.includes(key) == false) {
                target[key] = deepCopy(entry[key]);
            }
        }
        if (rest.length > 0) {
            Object.assign(target, ...rest);
        }

        return target;
    }

    function deepCopy(value) {
        if (Array.isArray(value)) {
            return value.map(deepCopy);
        } else if (typeof value == 'object') {
            return [...Object.entries(value)].reduce((p, [k, v]) => Object.assign(p, { [k]: deepCopy(v) }), {});
        } else {
            return value;
        }
    }

    var storage = initPlugin;

    const { ConflictError: ConflictError$1, CredentialError: CredentialError$1, RequestError: RequestError$2 } = errors;

    function initPlugin$1(settings) {
        const identity = settings.identity;

        return function decorateContext(context, request) {
            context.auth = {
                register,
                login,
                logout
            };

            const userToken = request.headers['x-authorization'];
            if (userToken !== undefined) {
                let user;
                const session = findSessionByToken(userToken);
                if (session !== undefined) {
                    const userData = context.protectedStorage.get('users', session.userId);
                    if (userData !== undefined) {
                        console.log('Authorized as ' + userData[identity]);
                        user = userData;
                    }
                }
                if (user !== undefined) {
                    context.user = user;
                } else {
                    throw new CredentialError$1('Invalid access token');
                }
            }

            function register(body) {
                if (body.hasOwnProperty(identity) === false ||
                    body.hasOwnProperty('password') === false ||
                    body[identity].length == 0 ||
                    body.password.length == 0) {
                    throw new RequestError$2('Missing fields');
                } else if (context.protectedStorage.query('users', { [identity]: body[identity] }).length !== 0) {
                    throw new ConflictError$1(`A user with the same ${identity} already exists`);
                } else {
                    const newUser = Object.assign({}, body, {
                        [identity]: body[identity],
                        hashedPassword: hash(body.password)
                    });
                    const result = context.protectedStorage.add('users', newUser);
                    delete result.hashedPassword;

                    const session = saveSession(result._id);
                    result.accessToken = session.accessToken;

                    return result;
                }
            }

            function login(body) {
                const targetUser = context.protectedStorage.query('users', { [identity]: body[identity] });
                if (targetUser.length == 1) {
                    if (hash(body.password) === targetUser[0].hashedPassword) {
                        const result = targetUser[0];
                        delete result.hashedPassword;

                        const session = saveSession(result._id);
                        result.accessToken = session.accessToken;

                        return result;
                    } else {
                        throw new CredentialError$1('Login or password don\'t match');
                    }
                } else {
                    throw new CredentialError$1('Login or password don\'t match');
                }
            }

            function logout() {
                if (context.user !== undefined) {
                    const session = findSessionByUserId(context.user._id);
                    if (session !== undefined) {
                        context.protectedStorage.delete('sessions', session._id);
                    }
                } else {
                    throw new CredentialError$1('User session does not exist');
                }
            }

            function saveSession(userId) {
                let session = context.protectedStorage.add('sessions', { userId });
                const accessToken = hash(session._id);
                session = context.protectedStorage.set('sessions', session._id, Object.assign({ accessToken }, session));
                return session;
            }

            function findSessionByToken(userToken) {
                return context.protectedStorage.query('sessions', { accessToken: userToken })[0];
            }

            function findSessionByUserId(userId) {
                return context.protectedStorage.query('sessions', { userId })[0];
            }
        };
    }


    const secret = 'This is not a production server';

    function hash(string) {
        const hash = crypto__default['default'].createHmac('sha256', secret);
        hash.update(string);
        return hash.digest('hex');
    }

    var auth = initPlugin$1;

    function initPlugin$2(settings) {
        const util = {
            throttle: false
        };

        return function decoreateContext(context, request) {
            context.util = util;
        };
    }

    var util$2 = initPlugin$2;

    /*
     * This plugin requires auth and storage plugins
     */

    const { RequestError: RequestError$3, ConflictError: ConflictError$2, CredentialError: CredentialError$2, AuthorizationError: AuthorizationError$2 } = errors;

    function initPlugin$3(settings) {
        const actions = {
            'GET': '.read',
            'POST': '.create',
            'PUT': '.update',
            'PATCH': '.update',
            'DELETE': '.delete'
        };
        const rules = Object.assign({
            '*': {
                '.create': ['User'],
                '.update': ['Owner'],
                '.delete': ['Owner']
            }
        }, settings.rules);

        return function decorateContext(context, request) {
            // special rules (evaluated at run-time)
            const get = (collectionName, id) => {
                return context.storage.get(collectionName, id);
            };
            const isOwner = (user, object) => {
                return user._id == object._ownerId;
            };
            context.rules = {
                get,
                isOwner
            };
            const isAdmin = request.headers.hasOwnProperty('x-admin');

            context.canAccess = canAccess;

            function canAccess(data, newData) {
                const user = context.user;
                const action = actions[request.method];
                let { rule, propRules } = getRule(action, context.params.collection, data);

                if (Array.isArray(rule)) {
                    rule = checkRoles(rule, data);
                } else if (typeof rule == 'string') {
                    rule = !!(eval(rule));
                }
                if (!rule && !isAdmin) {
                    throw new CredentialError$2();
                }
                propRules.map(r => applyPropRule(action, r, user, data, newData));
            }

            function applyPropRule(action, [prop, rule], user, data, newData) {
                // NOTE: user needs to be in scope for eval to work on certain rules
                if (typeof rule == 'string') {
                    rule = !!eval(rule);
                }

                if (rule == false) {
                    if (action == '.create' || action == '.update') {
                        delete newData[prop];
                    } else if (action == '.read') {
                        delete data[prop];
                    }
                }
            }

            function checkRoles(roles, data, newData) {
                if (roles.includes('Guest')) {
                    return true;
                } else if (!context.user && !isAdmin) {
                    throw new AuthorizationError$2();
                } else if (roles.includes('User')) {
                    return true;
                } else if (context.user && roles.includes('Owner')) {
                    return context.user._id == data._ownerId;
                } else {
                    return false;
                }
            }
        };



        function getRule(action, collection, data = {}) {
            let currentRule = ruleOrDefault(true, rules['*'][action]);
            let propRules = [];

            // Top-level rules for the collection
            const collectionRules = rules[collection];
            if (collectionRules !== undefined) {
                // Top-level rule for the specific action for the collection
                currentRule = ruleOrDefault(currentRule, collectionRules[action]);

                // Prop rules
                const allPropRules = collectionRules['*'];
                if (allPropRules !== undefined) {
                    propRules = ruleOrDefault(propRules, getPropRule(allPropRules, action));
                }

                // Rules by record id 
                const recordRules = collectionRules[data._id];
                if (recordRules !== undefined) {
                    currentRule = ruleOrDefault(currentRule, recordRules[action]);
                    propRules = ruleOrDefault(propRules, getPropRule(recordRules, action));
                }
            }

            return {
                rule: currentRule,
                propRules
            };
        }

        function ruleOrDefault(current, rule) {
            return (rule === undefined || rule.length === 0) ? current : rule;
        }

        function getPropRule(record, action) {
            const props = Object
                .entries(record)
                .filter(([k]) => k[0] != '.')
                .filter(([k, v]) => v.hasOwnProperty(action))
                .map(([k, v]) => [k, v[action]]);

            return props;
        }
    }

    var rules = initPlugin$3;

    var identity = "email";
    var protectedData = {
        users: {
            "35c62d76-8152-4626-8712-eeb96381bea8": {
                email: "peter@abv.bg",
                username: "Peter",
                hashedPassword: "83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1"
            },
            "847ec027-f659-4086-8032-5173e2f9c93a": {
                email: "george@abv.bg",
                username: "George",
                hashedPassword: "83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1"
            },
            "60f0cf0b-34b0-4abd-9769-8c42f830dffc": {
                email: "admin@abv.bg",
                username: "Admin",
                hashedPassword: "fac7060c3e17e6f151f247eacb2cd5ae80b8c36aedb8764e18a41bbdc16aa302"
            }
        },
        sessions: {
        }
    };
    var seedData = {
        games: {
            "1c984097-4904-4b22-88c6-64f5e11d476a": {
                "_ownerId": "60f0cf0b-34b0-4abd-9769-8c42f830dffc",
                "title": "Cover Fire",
                "category": "Action",
                "maxLevel": "8",
                "imageUrl": "data:image/jpeg;base64,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",
                "summary": "Set in a world where fantasy creatures live side by side with humans. A human cop is forced to work with an Orc to find a weapon everyone is prepared to kill for. Set in a world where fantasy creatures live side by side with humans. A human cop is forced to work with an Orc to find a weapon everyone is prepared to kill for.",
                "_createdOn": 1776860061239,
                "_id": "1c984097-4904-4b22-88c6-64f5e11d476a"
            },
            "d38dd735-29f6-49ba-8c9b-5c30faf9e341": {
                "_ownerId": "60f0cf0b-34b0-4abd-9769-8c42f830dffc",
                "title": "MineCraft",
                "category": "Survival",
                "maxLevel": "10",
                "imageUrl": "data:image/jpeg;base64,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",
                "summary": "Set in a world where fantasy creatures live side by side with humans. A human cop is forced to work with an Orc to find a weapon everyone is prepared to kill for. Set in a world where fantasy creatures live side by side with humans. A human cop is forced to work with an Orc to find a weapon everyone is prepared to kill for.",
                "_createdOn": 1776860128438,
                "_id": "d38dd735-29f6-49ba-8c9b-5c30faf9e341"
            },
            "5894942a-a8ea-4278-8856-cff3bea31491": {
                "_ownerId": "60f0cf0b-34b0-4abd-9769-8c42f830dffc",
                "title": "Zombie Lang",
                "category": "Arcade shooter",
                "maxLevel": "13",
                "imageUrl": "data:image/jpeg;base64,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",
                "summary": "Set in a world where fantasy creatures live side by side with humans. A human cop is forced to work with an Orc to find a weapon everyone is prepared to kill for. Set in a world where fantasy creatures live side by side with humans. A human cop is forced to work with an Orc to find a weapon everyone is prepared to kill for.",
                "_createdOn": 1776860181482,
                "_id": "5894942a-a8ea-4278-8856-cff3bea31491"
            }

        },
        recipes: {
            "3987279d-0ad4-4afb-8ca9-5b256ae3b298": {
                _ownerId: "35c62d76-8152-4626-8712-eeb96381bea8",
                name: "Easy Lasagna",
                img: "assets/lasagna.jpg",
                ingredients: [
                    "1 tbsp Ingredient 1",
                    "2 cups Ingredient 2",
                    "500 g  Ingredient 3",
                    "25 g Ingredient 4"
                ],
                steps: [
                    "Prepare ingredients",
                    "Mix ingredients",
                    "Cook until done"
                ],
                _createdOn: 1613551279012
            },
            "8f414b4f-ab39-4d36-bedb-2ad69da9c830": {
                _ownerId: "35c62d76-8152-4626-8712-eeb96381bea8",
                name: "Grilled Duck Fillet",
                img: "assets/roast.jpg",
                ingredients: [
                    "500 g  Ingredient 1",
                    "3 tbsp Ingredient 2",
                    "2 cups Ingredient 3"
                ],
                steps: [
                    "Prepare ingredients",
                    "Mix ingredients",
                    "Cook until done"
                ],
                _createdOn: 1613551344360
            },
            "985d9eab-ad2e-4622-a5c8-116261fb1fd2": {
                _ownerId: "847ec027-f659-4086-8032-5173e2f9c93a",
                name: "Roast Trout",
                img: "assets/fish.jpg",
                ingredients: [
                    "4 cups Ingredient 1",
                    "1 tbsp Ingredient 2",
                    "1 tbsp Ingredient 3",
                    "750 g  Ingredient 4",
                    "25 g Ingredient 5"
                ],
                steps: [
                    "Prepare ingredients",
                    "Mix ingredients",
                    "Cook until done"
                ],
                _createdOn: 1613551388703
            }
        },
        comments: {
            "0a272c58-b7ea-4e09-a000-7ec988248f66": {
                _ownerId: "35c62d76-8152-4626-8712-eeb96381bea8",
                content: "Great recipe!",
                recipeId: "8f414b4f-ab39-4d36-bedb-2ad69da9c830",
                _createdOn: 1614260681375,
                _id: "0a272c58-b7ea-4e09-a000-7ec988248f66"
            }
        },
        records: {
            i01: {
                name: "John1",
                val: 1,
                _createdOn: 1613551388703
            },
            i02: {
                name: "John2",
                val: 1,
                _createdOn: 1613551388713
            },
            i03: {
                name: "John3",
                val: 2,
                _createdOn: 1613551388723
            },
            i04: {
                name: "John4",
                val: 2,
                _createdOn: 1613551388733
            },
            i05: {
                name: "John5",
                val: 2,
                _createdOn: 1613551388743
            },
            i06: {
                name: "John6",
                val: 3,
                _createdOn: 1613551388753
            },
            i07: {
                name: "John7",
                val: 3,
                _createdOn: 1613551388763
            },
            i08: {
                name: "John8",
                val: 2,
                _createdOn: 1613551388773
            },
            i09: {
                name: "John9",
                val: 3,
                _createdOn: 1613551388783
            },
            i10: {
                name: "John10",
                val: 1,
                _createdOn: 1613551388793
            }
        },
        catches: {
            "07f260f4-466c-4607-9a33-f7273b24f1b4": {
                _ownerId: "35c62d76-8152-4626-8712-eeb96381bea8",
                angler: "Paulo Admorim",
                weight: 636,
                species: "Atlantic Blue Marlin",
                location: "Vitoria, Brazil",
                bait: "trolled pink",
                captureTime: 80,
                _createdOn: 1614760714812,
                _id: "07f260f4-466c-4607-9a33-f7273b24f1b4"
            },
            "bdabf5e9-23be-40a1-9f14-9117b6702a9d": {
                _ownerId: "847ec027-f659-4086-8032-5173e2f9c93a",
                angler: "John Does",
                weight: 554,
                species: "Atlantic Blue Marlin",
                location: "Buenos Aires, Argentina",
                bait: "trolled pink",
                captureTime: 120,
                _createdOn: 1614760782277,
                _id: "bdabf5e9-23be-40a1-9f14-9117b6702a9d"
            }
        },
        furniture: {
        },
        orders: {
        },
        movies: {
            "1240549d-f0e0-497e-ab99-eb8f703713d7": {
                _ownerId: "847ec027-f659-4086-8032-5173e2f9c93a",
                title: "Black Widow",
                description: "Natasha Romanoff aka Black Widow confronts the darker parts of her ledger when a dangerous conspiracy with ties to her past arises. Comes on the screens 2020.",
                img: "https://miro.medium.com/max/735/1*akkAa2CcbKqHsvqVusF3-w.jpeg",
                _createdOn: 1614935055353,
                _id: "1240549d-f0e0-497e-ab99-eb8f703713d7"
            },
            "143e5265-333e-4150-80e4-16b61de31aa0": {
                _ownerId: "847ec027-f659-4086-8032-5173e2f9c93a",
                title: "Wonder Woman 1984",
                description: "Diana must contend with a work colleague and businessman, whose desire for extreme wealth sends the world down a path of destruction, after an ancient artifact that grants wishes goes missing.",
                img: "https://pbs.twimg.com/media/ETINgKwWAAAyA4r.jpg",
                _createdOn: 1614935181470,
                _id: "143e5265-333e-4150-80e4-16b61de31aa0"
            },
            "a9bae6d8-793e-46c4-a9db-deb9e3484909": {
                _ownerId: "35c62d76-8152-4626-8712-eeb96381bea8",
                title: "Top Gun 2",
                description: "After more than thirty years of service as one of the Navy's top aviators, Pete Mitchell is where he belongs, pushing the envelope as a courageous test pilot and dodging the advancement in rank that would ground him.",
                img: "https://i.pinimg.com/originals/f2/a4/58/f2a458048757bc6914d559c9e4dc962a.jpg",
                _createdOn: 1614935268135,
                _id: "a9bae6d8-793e-46c4-a9db-deb9e3484909"
            }
        },
        likes: {
        },
        ideas: {
            "833e0e57-71dc-42c0-b387-0ce0caf5225e": {
                _ownerId: "847ec027-f659-4086-8032-5173e2f9c93a",
                title: "Best Pilates Workout To Do At Home",
                description: "Lorem ipsum dolor, sit amet consectetur adipisicing elit. Minima possimus eveniet ullam aspernatur corporis tempore quia nesciunt nostrum mollitia consequatur. At ducimus amet aliquid magnam nulla sed totam blanditiis ullam atque facilis corrupti quidem nisi iusto saepe, consectetur culpa possimus quos? Repellendus, dicta pariatur! Delectus, placeat debitis error dignissimos nesciunt magni possimus quo nulla, fuga corporis maxime minus nihil doloremque aliquam quia recusandae harum. Molestias dolorum recusandae commodi velit cum sapiente placeat alias rerum illum repudiandae? Suscipit tempore dolore autem, neque debitis quisquam molestias officia hic nesciunt? Obcaecati optio fugit blanditiis, explicabo odio at dicta asperiores distinctio expedita dolor est aperiam earum! Molestias sequi aliquid molestiae, voluptatum doloremque saepe dignissimos quidem quas harum quo. Eum nemo voluptatem hic corrupti officiis eaque et temporibus error totam numquam sequi nostrum assumenda eius voluptatibus quia sed vel, rerum, excepturi maxime? Pariatur, provident hic? Soluta corrupti aspernatur exercitationem vitae accusantium ut ullam dolor quod!",
                img: "./images/best-pilates-youtube-workouts-2__medium_4x3.jpg",
                _createdOn: 1615033373504,
                _id: "833e0e57-71dc-42c0-b387-0ce0caf5225e"
            },
            "247efaa7-8a3e-48a7-813f-b5bfdad0f46c": {
                _ownerId: "847ec027-f659-4086-8032-5173e2f9c93a",
                title: "4 Eady DIY Idea To Try!",
                description: "Similique rem culpa nemo hic recusandae perspiciatis quidem, quia expedita, sapiente est itaque optio enim placeat voluptates sit, fugit dignissimos tenetur temporibus exercitationem in quis magni sunt vel. Corporis officiis ut sapiente exercitationem consectetur debitis suscipit laborum quo enim iusto, labore, quod quam libero aliquid accusantium! Voluptatum quos porro fugit soluta tempore praesentium ratione dolorum impedit sunt dolores quod labore laudantium beatae architecto perspiciatis natus cupiditate, iure quia aliquid, iusto modi esse!",
                img: "./images/brightideacropped.jpg",
                _createdOn: 1615033452480,
                _id: "247efaa7-8a3e-48a7-813f-b5bfdad0f46c"
            },
            "b8608c22-dd57-4b24-948e-b358f536b958": {
                _ownerId: "35c62d76-8152-4626-8712-eeb96381bea8",
                title: "Dinner Recipe",
                description: "Consectetur labore et corporis nihil, officiis tempora, hic ex commodi sit aspernatur ad minima? Voluptas nesciunt, blanditiis ex nulla incidunt facere tempora laborum ut aliquid beatae obcaecati quidem reprehenderit consequatur quis iure natus quia totam vel. Amet explicabo quidem repellat unde tempore et totam minima mollitia, adipisci vel autem, enim voluptatem quasi exercitationem dolor cum repudiandae dolores nostrum sit ullam atque dicta, tempora iusto eaque! Rerum debitis voluptate impedit corrupti quibusdam consequatur minima, earum asperiores soluta. A provident reiciendis voluptates et numquam totam eveniet! Dolorum corporis libero dicta laborum illum accusamus ullam?",
                img: "./images/dinner.jpg",
                _createdOn: 1615033491967,
                _id: "b8608c22-dd57-4b24-948e-b358f536b958"
            }
        },
        catalog: {
            "53d4dbf5-7f41-47ba-b485-43eccb91cb95": {
                _ownerId: "35c62d76-8152-4626-8712-eeb96381bea8",
                make: "Table",
                model: "Swedish",
                year: 2015,
                description: "Medium table",
                price: 235,
                img: "./images/table.png",
                material: "Hardwood",
                _createdOn: 1615545143015,
                _id: "53d4dbf5-7f41-47ba-b485-43eccb91cb95"
            },
            "f5929b5c-bca4-4026-8e6e-c09e73908f77": {
                _ownerId: "847ec027-f659-4086-8032-5173e2f9c93a",
                make: "Sofa",
                model: "ES-549-M",
                year: 2018,
                description: "Three-person sofa, blue",
                price: 1200,
                img: "./images/sofa.jpg",
                material: "Frame - steel, plastic; Upholstery - fabric",
                _createdOn: 1615545572296,
                _id: "f5929b5c-bca4-4026-8e6e-c09e73908f77"
            },
            "c7f51805-242b-45ed-ae3e-80b68605141b": {
                _ownerId: "847ec027-f659-4086-8032-5173e2f9c93a",
                make: "Chair",
                model: "Bright Dining Collection",
                year: 2017,
                description: "Dining chair",
                price: 180,
                img: "./images/chair.jpg",
                material: "Wood laminate; leather",
                _createdOn: 1615546332126,
                _id: "c7f51805-242b-45ed-ae3e-80b68605141b"
            }
        },
        teams: {
            "34a1cab1-81f1-47e5-aec3-ab6c9810efe1": {
                _ownerId: "35c62d76-8152-4626-8712-eeb96381bea8",
                name: "Storm Troopers",
                logoUrl: "/assets/atat.png",
                description: "These ARE the droids we're looking for",
                _createdOn: 1615737591748,
                _id: "34a1cab1-81f1-47e5-aec3-ab6c9810efe1"
            },
            "dc888b1a-400f-47f3-9619-07607966feb8": {
                _ownerId: "847ec027-f659-4086-8032-5173e2f9c93a",
                name: "Team Rocket",
                logoUrl: "/assets/rocket.png",
                description: "Gotta catch 'em all!",
                _createdOn: 1615737655083,
                _id: "dc888b1a-400f-47f3-9619-07607966feb8"
            },
            "733fa9a1-26b6-490d-b299-21f120b2f53a": {
                _ownerId: "847ec027-f659-4086-8032-5173e2f9c93a",
                name: "Minions",
                logoUrl: "/assets/hydrant.png",
                description: "Friendly neighbourhood jelly beans, helping evil-doers succeed.",
                _createdOn: 1615737688036,
                _id: "733fa9a1-26b6-490d-b299-21f120b2f53a"
            }
        },
        members: {
            "cc9b0a0f-655d-45d7-9857-0a61c6bb2c4d": {
                _ownerId: "35c62d76-8152-4626-8712-eeb96381bea8",
                teamId: "34a1cab1-81f1-47e5-aec3-ab6c9810efe1",
                status: "member",
                _createdOn: 1616236790262,
                _updatedOn: 1616236792930
            },
            "61a19986-3b86-4347-8ca4-8c074ed87591": {
                _ownerId: "847ec027-f659-4086-8032-5173e2f9c93a",
                teamId: "dc888b1a-400f-47f3-9619-07607966feb8",
                status: "member",
                _createdOn: 1616237188183,
                _updatedOn: 1616237189016
            },
            "8a03aa56-7a82-4a6b-9821-91349fbc552f": {
                _ownerId: "847ec027-f659-4086-8032-5173e2f9c93a",
                teamId: "733fa9a1-26b6-490d-b299-21f120b2f53a",
                status: "member",
                _createdOn: 1616237193355,
                _updatedOn: 1616237195145
            },
            "9be3ac7d-2c6e-4d74-b187-04105ab7e3d6": {
                _ownerId: "35c62d76-8152-4626-8712-eeb96381bea8",
                teamId: "dc888b1a-400f-47f3-9619-07607966feb8",
                status: "member",
                _createdOn: 1616237231299,
                _updatedOn: 1616237235713
            },
            "280b4a1a-d0f3-4639-aa54-6d9158365152": {
                _ownerId: "60f0cf0b-34b0-4abd-9769-8c42f830dffc",
                teamId: "dc888b1a-400f-47f3-9619-07607966feb8",
                status: "member",
                _createdOn: 1616237257265,
                _updatedOn: 1616237278248
            },
            "e797fa57-bf0a-4749-8028-72dba715e5f8": {
                _ownerId: "60f0cf0b-34b0-4abd-9769-8c42f830dffc",
                teamId: "34a1cab1-81f1-47e5-aec3-ab6c9810efe1",
                status: "member",
                _createdOn: 1616237272948,
                _updatedOn: 1616237293676
            }
        }
    };
    var rules$1 = {
        users: {
            ".create": false,
            ".read": [
                "Owner"
            ],
            ".update": false,
            ".delete": false
        },
        members: {
            ".update": "isOwner(user, get('teams', data.teamId))",
            ".delete": "isOwner(user, get('teams', data.teamId)) || isOwner(user, data)",
            "*": {
                teamId: {
                    ".update": "newData.teamId = data.teamId"
                },
                status: {
                    ".create": "newData.status = 'pending'"
                }
            }
        }
    };
    var settings = {
        identity: identity,
        protectedData: protectedData,
        seedData: seedData,
        rules: rules$1
    };

    const plugins = [
        storage(settings),
        auth(settings),
        util$2(),
        rules(settings)
    ];

    const server = http__default['default'].createServer(requestHandler(plugins, services));

    const port = 3030;

    server.listen(port);

    console.log(`Server started on port ${port}. You can make requests to http://localhost:${port}/`);
    console.log(`Admin panel located at http://localhost:${port}/admin`);

    var softuniPracticeServer = server;

    return softuniPracticeServer;

})));
