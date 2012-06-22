var http = require('http'),
    RPC = require('./rpc.js'),
    cluster = require('cluster'),
    attackers = {}, // the ban list
    banDuration = 60; // how long a ban on an IP lasts

if (cluster.isMaster) {
    (function() {
        var maxWorkers = 100, // the maximum number of workers allowed at any given time
            minWorkers = require('os').cpus().length, // the minimum number of workers we should have
            maxExtraWorkerPercent = 10, // the maximum extra workers at any given time for requests per sec
            requestsPerIPPerSecond = 5, // requests allowed per ip per second
            workers = [], // the array of workers as cluster forks
            workerCount = 0, // a counter for workers to bypass using .length
            requestCount = 0, // the number of requests during a given timeframe (around one second)
            lastRequest = 0, // the most recent request's time
            attackerCheck = {}, // replaced often to keep track of attackers according to reqs/sec
            attackersOrdered = [], // used for cleaning up quickly
            startWorker, worker, handleMessage;

        // handle the messages from the workers
        handleMessage = function(msg) {
            if (!msg || !msg.cmd) {
                return;
            }
            switch (msg.cmd) {
                case 'request':
                    requestCount++;
                    if (msg.ipAddress) {
                        if (!attackerCheck[msg.ipAddress]) {
                            attackerCheck[msg.ipAddress] = 1;
                        } else {
                            attackerCheck[msg.ipAddress]++;
                        }

                        // if they exceeded their allotted requests per second, add them to the attackers array
                        if (attackerCheck[msg.ipAddress] > requestsPerIPPerSecond) {
                            // don't update the ban if they have already been banned
                            if (!attackers[msg.ipAddress]) {
                                attackers[msg.ipAddress] = ~~(+(new Date()) / 1000);
                                attackersOrdered.push(msg.ipAddress);
                            }
                        }
                    }
                    break;
                case 'online':
                    this.send({'cmd': 'updateAttackers', 'attackers': attackers});
                    break;
            }
        };

        // start a worker and add it to the pool of workers
        startWorker = function() {
            var worker = cluster.fork();
            workers.push(worker);
            workerCount++;
            worker.on('message', handleMessage);
            console.log('started', worker.pid, workers.length, workerCount);
        };

        // if a worker dies, remove it from the pool of workers and start a new worker if we have less than the minimum left
        cluster.on('death', function(worker) {
            var i = workers.length;
            while (i--) {
                if (workers[i] == worker) {
                    workerCount--;
                    workers.splice(i, 1);
                    break;
                }
            }

            console.log('died', worker.pid, workers.length, workerCount);

            if (workerCount < minWorkers) {
                // ensure we have at least the minimum workers
                startWorker();
            }
        });

        // reset the attacker checking on (approximately) 1s intervals
        setInterval(function() {
            attackerCheck = {};
        }, 1000);

        // propogate the attackers array to workers every 300ms
        setInterval(function() {
            var i = workers.length;
            while (i--) {
                workers[i].send({'cmd': 'updateAttackers', 'attackers': attackers});
            }
        }, 300);

        // curb our attackers hash in case it gets too large, every 60s
        setInterval(function() {
            var time = ~~(+(new Date()) / 1000);
            if (attackersOrdered.length > 0) {
                for (var i = 0, removes = 0; ipAddress = attackersOrdered[i]; i++) {
                    if (attackers[ipAddress] + banDuration < time) {
                        delete attackers[ipAddress];
                        removes++;
                    } else {
                        break;
                    }
                }
                if (removes) {
                    attackersOrdered.splice(0, removes);
                }
            }
        }, 60000);

        // allocate and deallocate based on requests per second
        var overAllocations = 0;
        setInterval(function() {
            // get an integer representation of the timestamp (limited to 32 bit here)
            var time = ~~(+(new Date()) / 1000);

            // reset the count and set the time if it has changed
            if (time != lastRequest) {
                requestCount = 0;
                lastRequest = time;
                overAllocations = 0;
            }

            // if the current request count is higher than the worker count this second, start 1 new worker
            if (requestCount > workerCount && workerCount < maxWorkers) {
                startWorker();

            // allow having up to 10% extra workers but deallocate if we exceed that demand greatly
            } else if (requestCount + (Math.random() * (requestCount / maxExtraWorkerPercent)) < workerCount) {
                overAllocations++;

                // deallocate if after 8 intervals we are still over allocated
                if (overAllocations >= 8 && workerCount > minWorkers) {
                    var worker = workers[workers.length - 1];
                    if (worker) {
                        worker.kill();
                        overAllocations = 0;
                    }
                }
            }
        }, 100);

        // start the minimum workers
        for (var i = 0, l = minWorkers; i < l; i++) {
            startWorker();
        }
    })();
} else {
    (function() {
        var fs = require('fs'),
            handleMessage, checkIfAttacker;
        
        handleMessage = function(msg) {
            if (msg && msg.cmd && msg.cmd == 'updateAttackers') {
                attackers = msg.attackers;
            }
        };
        process.on('message', handleMessage);

        checkIsAttacker = function(ipAddress) {
            var time = ~~(+(new Date()) / 1000),
                bannedTime = attackers[ipAddress];

            // whether they are banned based on time
            if (bannedTime && bannedTime + banDuration > time) {
                return true;
            }

            return false;
        };

        http.createServer(function (request, response) {
            // ignore the favicon.ico file
            if (request.url == '/favicon.ico') {
                return;
            }

            if (request.url == '/test.html') {
                fs.readFile('./test.html', function(error, content) {
                    if (error) {
                        response.writeHead(500);
                        response.end();
                    } else {
                        response.writeHead(200, { 'Content-Type': 'text/html' });
                        response.end(content, 'utf-8');
                    }
                });
                return;
            }

            // don't send a response if they are marked as an attacker
            if (checkIsAttacker(request.connection.address().address)) {
                return;
            }

            // send the request to the RPC server
            new RPC(request, response);
        }).listen(81, '0.0.0.0');
    })();
}
