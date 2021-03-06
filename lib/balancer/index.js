var http = require('http'),
    net = require('net'),
    sys = require('sys'),
    fs = require('fs'),
    Buffer = require('buffer').Buffer,
    CRLF = '\r\n',
    version = '0.2.2';

exports.version = version;
    
function parseRegExp(a) {
  if (a instanceof Array) {
    return new RegExp(a[0], a[1]);
  } else {
    return new RegExp(a);
  }
}
    
var Balancer = exports.Balancer = function(config) {
  // Parse servers config var
  // each "servername:port" will be ["servername", "port", "hostname"]
  // Difference between "servername" and "hostname":
  // For "localhost:8080" hostname will be "localhost:8080",
  // But for "localhost:80" -> "localhost"
  var servers = config.servers,
      _servers = [];

  if (servers instanceof Array) {
    for (var i = 0, len = servers.length; i < len; i++) {
      var t = servers[i].split(':', 2);
      _servers[i] = [t[0], t[1]-0, t[0] + (t[1] - 80 == 0 ? '' : ':' + t[1])];
    }
  }

  if (!_servers.length) {
    throw Error('node-balancer >> You must define at least one server');
  }

  // Parse spread value
  var _spread;
  if (config.spread) {
    _spread = {};
    _spread.include = parseRegExp(config.spread.include);
    _spread.exclude = parseRegExp(config.spread.exclude);
    _spread.single = config.spread.single ? true : false;
  }

  // Parse addr
  var _addr = ['127.0.0.1', '8080'];
  if (config.addr) {
    var _addr = config.addr.split(':', 2);
    _addr[2] = _addr[0] + (_addr[1] - 80 == 0 ? '' : ':' + _addr[1]);
  }

  // Parse log
  var _log = config.log || function(msg) {sys.puts('node-balancer >> ' + msg);};

  
  // Get hostname
  if (config.hostname) {
    _addr[2] = config.hostname;
  }
  
  return start(_addr, _servers, _spread, _log, config.profiler);
}

// Get server-num by ip
function hashIp(request, max) {
  var ip = request.socket.remoteAddress.split('.');

  return (ip[0] * 65536 + ip[1] * 256 + ip[2]) % max;
}

// Init socket stuff
function init_socket(socket, server) {
  // Copied from different sources
  socket.setTimeout(0);
  socket.setNoDelay(true);
  if (server) {
    socket.setKeepAlive(true, 0);
  } else {
    socket.setEncoding('utf8');
  }
}

// End socket or something
function _end(something) {
  return function() {
    something.end('');
    something.destroy && something.destroy();
  }
}

function start(addr, servers, spread, log, profiler) {
  var serverslen = servers.length;

  var server = http.createServer(function(request, response) {
    var id, selected;

    if (spread && (!spread.include || spread.include.test(request.url)) &&
        (!spread.exclude || !spread.exclude.test(request.url))) {
      // Spray between
      id = Math.floor(Math.random() * serverslen);
    } else {
      // Get hashed
      id = spread.single ? 0 : hashIp(request, serverslen);
    }

    // Get server
    selected = servers[id];

    // Change request host to servers'
    request.headers.host = selected[2];

    try {
      // Connect to server
      var remote_request = http.createClient(selected[1], selected[0])
                              .request(request.method, request.url,
                                       request.headers);
      remote_request.on('response', function(remote_response) {

        // Pass headers
        remote_response.headers['X-Node-Balancer'] = version;
        response.writeHead(remote_response.statusCode, remote_response.headers);

        // Hate 304 status code
        // Spent 1 hour discovering this problem
        if (remote_response.statusCode === 304) {
          response.end('');
        }

        // Pass every chunk
        remote_response.on('data', function(chunk) {
          response.write(chunk);
        });

        // And close connection
        remote_response.on('end', function() {
          response.end('');
        });
      });

      // Pass every chunk to server
      // In case of POST query, e.t.c.
      request.on('data', function(chunk) {
        remote_request.write(chunk);
      });

      // End sync
      request.on('end', function() {
        // Get page or file
        remote_request.end('');
      });

    } catch(e) {
      log('Server error: ' + e);
      response.writeHead(500);
      response.end('Server error, try refreshing page');
    }
  });

  // Websocket proxy
  // Parse upgrade request
  server.on('upgrade', function(request, socket, head) {

    // Method must be GET and client must request update to websocket
    if (request.method !== 'GET' ||
        request.headers.upgrade.toLowerCase() !== 'websocket') {
      _end(socket)();
      return;
    }

    // Init socket stuff
    // Keep-alive, e.t.c.
    init_socket(socket);

    // Get matching server (by hash)
    var id = hashIp(request, serverslen),
        selected = servers[id];

    try {
      // Create socket & connect to server
      var remote_socket = new net.Stream();

      remote_socket.connect(selected[1], selected[0]);

      // Request template
      var data = 'GET ' + request.url + ' HTTP/1.1' + CRLF +
                 'Upgrade: WebSocket' + CRLF +
                 'Connection: Upgrade' + CRLF +
                 'Host: ' + selected[2] + CRLF +
                 'Origin: http://' + selected[2] + CRLF +
                 'Sec-WebSocket-Key1: ' + request.headers['sec-websocket-key1'] + CRLF +
                 'Sec-WebSocket-Key2: ' + request.headers['sec-websocket-key2'] + CRLF +
                 CRLF;

      // On connect
      remote_socket.on('connect', function() {
        // Initiate data listener
        // Init socket stuff
        // But without encoding
        init_socket(remote_socket, true);

        // First message must be handshake
        var handshake = true;
        remote_socket.on('data', function(data) {
          if (handshake) {

            // Ok, kind of harmfull part of code
            // Socket.IO is sending hash at the end of handshake
            // If protocol = 76
            // But we need to replace 'host' and 'origin' in response
            // So we split data to printable data and to non-printable
            // (Non-printable will come after double-CRLF)
            var sdata = data.toString();

            // Get Printable
            sdata = sdata
                      .substr(0, sdata.search(CRLF + CRLF));

            // Get Non-Printable
            data = data.slice(Buffer.byteLength(sdata), data.length);

            // Replace host and origin
            sdata = sdata
                      .replace(selected[2], addr[2])
                      .replace(selected[2], addr[2]);

            // Write printable
            socket.write(sdata);

            // Write non-printable
            socket.write(data);

            // Handshake can be only one time
            handshake = false;
          } else {
            // If not handshake - pass data
            socket.write(data);            
          }
        });

        // If client sends data
        socket.on('data', function(data) {
          // Pass it to server
          remote_socket.write(data);
        });

        // Pass printable request
        remote_socket.write(data);

        // Pass 8-byte random sequence
        remote_socket.write(head);
      });

      // On disconnections - terminate connections
      remote_socket.on('end', _end(socket));
      socket.on('end', _end(remote_socket));

      // On errors - terminate connections
      remote_socket.on('error', _end(socket));
      socket.on('error', _end(remote_socket));

    } catch (e) {
      // In case of some error - disconnect client
      _end(socket)();
      log('Error during connection try to server' + id);
    }

  });

  // Listen on port (default 80) and host
  server.listen((addr[1] - 0) || 80, addr[0]);

  log('Listening on ' + addr[2]);

  return server;
}
