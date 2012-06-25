/*
Many web applications need to be able to fetch content from user-supplied URLs.
Using a language of your choice, implement an RPC service that fetches the contents of untrusted URLs.

The service should expose an interface to the web application using either Thrift or HTTP.
It should be able to handle malicious users, misbehaving servers, and access from multiple clients simultaneously.
(You can assume the client itself is trusted, though.)
*/
var http = require('http'),
    util = require('util'),
    events = require('events'),
    url = require('url'),
    querystring = require('querystring'),
    errorObject = require('./errorObject.js'),
    RPC;

var klassProto = {
    error: null,
    currentMethod: '',
    currentRequest: {},

    init: function(request, response) {
        process.send({'cmd': 'request', 'ipAddress': request.connection.address().address});

        // add the default fail callback
        this.on('fail', function(error) {
            if (error) {
                this.error = error;
                response.writeHead(501, {'Content-Type': 'text/plain'});
                response.end(error.string);
                return;
            } else if (this.response) {
                response.writeHead(202, {'Content-Type': 'text/plain'});
                response.end(JSON.stringify(this.response));
                return;
            }
            response.writeHead(500, {'Content-Type': 'text/plain'});
            response.end();
        }.bind(this));

        // add the default done callback
        this.on('done', function() {
            response.writeHead(200, {'Content-Type': 'text/plain'});
            response.end(JSON.stringify(this.response));
        }.bind(this));

        this.on('parsed', this.run.bind(this));

        this.parse(request);
    },

    parse: function(request) {
        if (request.method == 'POST') {
            var postBody = [],
                rpc = this;
            request.on('data', function(chunk) {
                postBody.push(chunk.toString());
            });
            request.on('end', function() {
                postBody = querystring.parse(postBody.join(''));
                if (typeof postBody != 'object') {
                    rpc.emit('fail', RPC.errorObjects.INVALID_REQUEST);
                    return;
                }

                rpc.currentMethod = postBody.method;
                rpc.currentRequest = postBody;
                rpc.emit('parsed');
            });
        } else {
            var queryObject = url.parse(request.url, true).query;
            this.currentMethod = queryObject.method;
            this.currentRequest = queryObject;

            if (typeof queryObject != 'object') {
                this.emit('fail', RPC.errorObjects.INVALID_REQUEST);
                return;
            }
            this.emit('parsed');
        }
    },

    run: function() {
        if (!this.calls[this.currentMethod]) {
            this.emit('fail', RPC.errorObjects.METHOD_NOT_FOUND);
            return;
        }

        // run the call in this rpc instance's context
        this.calls[this.currentMethod].apply(this, [this.currentRequest]);
    },

    // RPC calls
    calls: {
        getURLContents: function(options) {
            if (!options.url) {
                return;
            }
            var data = [],
                self = this;

            var request = http.get(url.parse(options.url));
            request.on('response', function(response) {
                response.on('data', function(chunk) {
                    data.push(chunk.toString());
                });
                response.on('end', function(options) {
                    self.response = {'contents': data.join('')};
                    data = [];
                    self.emit('done');
                });
            });
            request.on('error', function(e) {
                self.response = {'contents': '', 'error': e.message};
                self.emit('fail');
            });
        }
    }
};


// define our constructor
RPC = function() {
    this.init.apply(this, arguments);
    this.constructor.super_.call(this);
};

// inherit from EventEmitter
util.inherits(RPC, events.EventEmitter);

// static properties
RPC.errorObjects = {
    'INVALID_REQUEST': new errorObject(1, 'An invalid request was received.  Please check the post body or query string.'),
    'METHOD_NOT_FOUND': new errorObject(2, 'The method was not found or no method was provided.')
};

// setup our prototype
var key;
for (key in klassProto) {
    RPC.prototype[key] = klassProto[key];
}

if (module && module.exports) {
    module.exports = RPC;
}
