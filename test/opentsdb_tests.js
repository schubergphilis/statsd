var fs           = require('fs'),
    net          = require('net'),
    temp         = require('temp'),
    spawn        = require('child_process').spawn,
    util          = require('util'),
    urlparse     = require('url').parse,
    _            = require('underscore'),
    dgram        = require('dgram'),
    qsparse      = require('querystring').parse,
    http         = require('http');


var writeconfig = function(text,worker,cb,obj){
  temp.open({suffix: '-statsdconf.js'}, function(err, info) {
    if (err) throw err;
    fs.write(info.fd, text);
    fs.close(info.fd, function(err) {
      if (err) throw err;
      worker(info.path,cb,obj);
    });
  });
}

var array_contents_are_equal = function(first,second){
  var intlen = _.intersection(first,second).length;
  var unlen = _.union(first,second).length;
  return (intlen == unlen) && (intlen == first.length);
}

var statsd_send = function(data,sock,host,port,cb){
  send_data = new Buffer(data);
  sock.send(send_data,0,send_data.length,port,host,function(err,bytes){
    if (err) {
      throw err;
    }
    cb();
  });
}

// keep collecting data until a specified timeout period has elapsed
// this will let us capture all data chunks so we don't miss one
var collect_for = function(server,timeout,cb){
  var received = [];
  var in_flight = 0;
  var start_time = new Date().getTime();
  var collector = function(req,res){
    in_flight += 1;
    var body = '';
    req.on('data',function(data){ body += data; });
    req.on('end',function(){
      received = received.concat(body.split("\n"));
      in_flight -= 1;
      if((in_flight < 1) && (new Date().getTime() > (start_time + timeout))){
          server.removeListener('request',collector);
          cb(received);
      }
    });
  }

  setTimeout(function (){
    server.removeListener('connection',collector);
    if((in_flight < 1)){
      cb(received);
    }
  },timeout);

  server.on('connection',collector);
}

module.exports = {
  setUp: function (callback) {
    this.testport = 31337;
    this.myflush = 200;
    var configfile = "{graphService: \"opentsdb\"\n\
               ,  batch: 200 \n\
               ,  flushInterval: " + this.myflush + " \n\
               ,  percentThreshold: 90\n\
               ,  port: 8125\n\
               ,  dumpMessages: false \n\
               ,  debug: false\n\
               ,  opentsdbPort: " + this.testport + "\n\
               ,  opentsdbHost: \"127.0.0.1\"}";

    this.acceptor = net.createServer();
    this.acceptor.listen(this.testport);
    this.sock = dgram.createSocket('udp4');

    this.server_up = true;
    this.ok_to_die = false;
    this.exit_callback_callback = process.exit;

    writeconfig(configfile,function(path,cb,obj){
      obj.path = path;
      obj.server = spawn('node',['stats.js', path]);
      obj.exit_callback = function (code) {
        obj.server_up = false;
        if(!obj.ok_to_die){
          console.log('node server unexpectedly quit with code: ' + code);
          process.exit(1);
        }
        else {
          obj.exit_callback_callback();
        }
      };
      obj.server.on('exit', obj.exit_callback);
      obj.server.stderr.on('data', function (data) {
        console.log('stderr: ' + data.toString().replace(/\n$/,''));
      });
      /*
      obj.server.stdout.on('data', function (data) {
        console.log('stdout: ' + data.toString().replace(/\n$/,''));
      });
      */
      obj.server.stdout.on('data', function (data) {
        // wait until server is up before we finish setUp
        if (data.toString().match(/server is up/)) {
          cb();
        }
      });

    },callback,this);
  },
  tearDown: function (callback) {
    this.sock.close();
    this.acceptor.close();
    this.ok_to_die = true;
    if(this.server_up){
      this.exit_callback_callback = callback;
      this.server.kill();
    } else {
      callback();
    }
  },

  send_well_formed_posts: function (test) {
    test.expect(2);

    // we should integrate a timeout into this
    this.acceptor.once('connection',function(c){
      var body = '';
      c.on('data',function(d){ body += d; });
      c.on('end',function(){
        var rows = body.split("\n");
        var entries = _.map(rows, function(x) {
          var chunks = x.split(' ');
          var data = {};
          data[chunks[1]] = chunks[3];
          return data;
        });
        test.ok(_.include(_.map(entries,function(x) { return _.keys(x)[0] }),'etsy.statsd.numStats'),'graphite output includes numStats');
        test.equal(_.find(entries, function(x) { return _.keys(x)[0] == 'etsy.statsd.numStats' })['etsy.statsd.numStats'],0);
        test.done();
      });
    });
  },

  timers_are_valid: function (test) {
    test.expect(4);

    var testvalue = 100;
    var me = this;
    this.acceptor.once('connection',function(c){
      statsd_send('a_test_value:' + testvalue + '|ms',me.sock,'127.0.0.1',8125,function(){
          collect_for(me.acceptor,me.myflush*2,function(strings){
            test.ok(strings.length > 0,'should receive some data');
            var hashes = _.map(strings, function(x) {
              var chunks = x.split(' ');
              var data = {};
              data[chunks[1]] = chunks[3];
              return data;
            });
            var numstat_test = function(post){
              var mykey = 'etsy.statsd.numStats';
              return _.include(_.keys(post),mykey) && (post[mykey] == 1);
            };
            test.ok(_.any(hashes,numstat_test), 'etsy.statsd.numStats should be 1');

            var testtimervalue_test = function(post){
              var mykey = 'etsy.stats.timers.mean_90';
              return _.include(_.keys(post),mykey) && (post[mykey] == testvalue);
            };
            test.ok(_.any(hashes,testtimervalue_test), 'etsy.stats.timers.a_test_value.mean should be ' + testvalue);

            var testtimervalue_test = function(post){
              var mykey = 'etsy.stats.timers.lower';
              return _.include(_.keys(post),mykey) && (post[mykey] == testvalue);
            };
            test.ok(_.any(hashes,testtimervalue_test), 'etsy.stats.timers.lower should be ' + testvalue);

            test.done();
          });
      });
    });
  },

  keys_are_valid: function (test) {
    test.expect(3);

    var testvalue = 100;
    var me = this;
    this.acceptor.once('connection',function(c){
      statsd_send('a_test_value:' + testvalue + '|ms',me.sock,'127.0.0.1',8125,function(){
          collect_for(me.acceptor,me.myflush*2,function(strings){
            test.ok(strings.length > 0,'should receive some data');
            var hashes = _.map(strings, function(x) {
              var chunks = x.split(' ');
              var data = {};
              data[chunks[1]] = chunks[4];
              return data;
            });
            var numstat_test = function(post){
              var mykey = 'etsy.statsd.numStats';
              return _.include(_.keys(post),mykey) && (post[mykey] == "key=statsd");
            };
            test.ok(_.any(hashes,numstat_test), 'key etsy.statsd.numStats should be statsd');

            var testtimervalue_test = function(post){
              var mykey = 'etsy.stats.timers.mean_90';
              return _.include(_.keys(post),mykey) && (post[mykey] == "key=a_test_value");
            };
            test.ok(_.any(hashes,testtimervalue_test), 'key for etsy.stats.timers.mean should be a_test_value');

            test.done();
          });
      });
    });
  },

  counts_are_valid: function (test) {
    test.expect(4);

    var testvalue = 100;
    var me = this;
    this.acceptor.once('connection',function(c){
      statsd_send('a_test_value:' + testvalue + '|c',me.sock,'127.0.0.1',8125,function(){
          collect_for(me.acceptor,me.myflush*2,function(strings){
            test.ok(strings.length > 0,'should receive some data');
            var hashes = _.map(strings, function(x) {
              var chunks = x.split(' ');
              var data = {};
              data[chunks[1]] = chunks[3];
              return data;
            });
            var numstat_test = function(post){
              var mykey = 'etsy.statsd.numStats';
              return _.include(_.keys(post),mykey) && (post[mykey] == 1);
            };
            test.ok(_.any(hashes,numstat_test), 'etsy.statsd.numStats should be 1');

            var testavgvalue_test = function(post){
              var mykey = 'etsy.stats';
              return _.include(_.keys(post),mykey) && (post[mykey] == (testvalue/(me.myflush / 1000)));
            };
            test.ok(_.any(hashes,testavgvalue_test), 'etsy.stats.a_test_value should be ' + (testvalue/(me.myflush / 1000)));

            var testcountvalue_test = function(post){
              var mykey = 'etsy.stats_counts';
              return _.include(_.keys(post),mykey) && (post[mykey] == testvalue);
            };
            test.ok(_.any(hashes,testcountvalue_test), 'etsy.stats_counts.a_test_value should be ' + testvalue);

            test.done();
          });
      });
    });
  }
}
