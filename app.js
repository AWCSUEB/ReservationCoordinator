var express = require('express');
var path = require('path');
var logger = require('morgan');
var bodyParser = require('body-parser');
var request = require('request');
var utility = require('./lib/utility');

var app = express();

//app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// sets number of customers and routes per provider
// this should be dynamic
var custsToGen = 5;
var routesToGen = 24;
var timerDefault = 180;

// Each agent should have
// ID
// Name (Default to Agent :ID)
// Last ping time
// Ready status
var agents = {};
var nextAgentId = 1;

// Each customer should have
// ID
// Route info
// List of agent submissions
var customers = {};

// Each provider should have
// ID
// Name
// URI
// Last comm time
var providers = {};
var lastProviderId = 1;

var routes = {};
var timer = timerDefault;
var timerHandle;

// game states
// NotReady: waiting for agents and sp to connect and ready
// Ready: all agents are ready
// Pending: loading customer list and routes
// Running: customer list and routes loaded
// Disconnected: waiting for a agent or sp to reconnect
var previousGameState = "Unknown";
var currentGameState = "NotReady";

function setGameState(state) {
  previousGameState = currentGameState;
  currentGameState = state;
  console.log("GS=" + currentGameState + " PS=" + previousGameState);
}

function readyTest() {
  // Only run code while in NotReady
  if (currentGameState != "NotReady") {
    return;
  }

  var rc = utility.readyCount(agents, providers);
  console.log("AR=" + rc.agentsReady.length + " PR=" + rc.providersReady.length + " ANR=" + rc.agentsNotReady.length + " PNR=" + rc.providersNotReady.length);

  if (rc.agentsReady.length > 0 && rc.agentsNotReady.length == 0 && rc.providersReady.length > 0 && rc.providersNotReady.length == 0) {
    setGameState("Ready");
    setTimeout(function() {
      // reset and collect routes from service providers
      var providerlist = Object.keys(providers);
      for (i=0; i<providerlist.length; i++) {
        var p = providers[providerlist[i]];
        p.playing = true;
        request({
          method: "POST",
          uri: p.uri + 'reset?n=' + routesToGen,
          json: true
        }, function(err, res, body) {
          var tmproutes = body;

          // load all route pairs e.g. AP,CF etc
          var routeslist = Object.keys(tmproutes);

          // for each route in list push onto array for that pair
          for (j=0; j<routeslist.length; j++) {
            var pair = routeslist[j];
            if (!routes[pair]) {
              routes[pair] = [];
            }

            routes[pair].push(tmproutes[pair]);
            p.routes.push(tmproutes[pair]);
          }
        })
      }

      // generate customer list
      customers = utility.genCustRequests(custsToGen);

      // mark playing agents
      for (var a in agents) {
        if (agents[a].ready) {
          agents[a].ready = false;
          agents[a].playing = true;
        }
      }

      // client will start polling ready frequently and will grab routes and customer list when available
      setGameState("Pending");
    }, 3000);
  } else {
    for (var a in agents) {
      agents[a].playing = false;
    }

    for (var p in providers) {
      providers[p].playing = false;
    }
  }
}

function runningTest() {
  // Only run code while in Pending
  if (currentGameState != "Pending") {
    return;
  }

  var customerList = Object.keys(customers);
  var providerList = Object.keys(providers);

  var customersReady = false;
  var providersReady = 0;

  if (customerList.length == custsToGen) {
    customersReady = true;
  }

  for (var i=0; i<providerList.length; i++) {
    var p = providers[providerList[i]];
    if (p.routes.length == routesToGen) {
      providersReady++;
    }
  }

  if (customersReady && providersReady == providerList.length) {
    setGameState("Running");
    timerHandle = setInterval(finishedTest, 1000);
  }
}

function disconnectTest() {
  if (currentGameState != "Running") {
    return;
  }

  var dc = utility.disconnectCount(agents, providers, currentGameState);

  // Only pause game for disconnected SP, not for disconnected Agent
  if (dc.badProviders > 0) {
    setGameState("Disconnected");
    clearInterval(timerHandle);
  }
}

function reconnectTest() {
  if (currentGameState != "Disconnected") {
    return;
  }

  var dc = utility.disconnectCount(agents, providers, currentGameState);

  if (dc.badAgents == 0 && dc.badProviders == 0) {
    setGameState("Running");
    timerHandle = setInterval(finishedTest, 1000);
  }
}

function finishedTest() {
  timer--;
  if (timer == 0) {
    setGameState("NotReady");
    clearInterval(timerHandle);
    timer = timerDefault;
    customers = {};
    routes = {};
    for (var p in providers) {
      providers[p].routes = []
    }
  }
}

function cleanupTest() {
  if (currentGameState != "NotReady") {
    return;
  }

  var dc = utility.disconnectCount(agents, providers, currentGameState);
  var last;
  var now;

  if (dc.badAgents.length > 0) {
    console.log("*** Deleting " + dc.badAgents.length + " stale agents ***");
  }

  for (var a in dc.badAgents) {
    last = agents[dc.badAgents[a]].lastpingtime;
    now = new Date().getTime();
    if (now - last > 30000) {
      delete agents[dc.badAgents[a]];
    }
  }

  if (dc.badProviders.length > 0) {
    console.log("*** Deleting " + dc.badProviders.length + " stale providers ***");
  }

  for (var p in dc.badProviders) {
    last = providers[dc.badProviders[p]].lastpingtime;
    now = new Date().getTime();
    if (now - last > 30000) {
      delete providers[dc.badProviders[p]];
    }
  }
}

setInterval(readyTest, 1000);
setInterval(runningTest, 1000);
setInterval(disconnectTest, 1000);
setInterval(reconnectTest, 1000);
setInterval(cleanupTest, 1000);

// CORS
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  next();
});

app.options('*', function(req, res, next) {
  res.send();
});

app.get('/', function(req, res, next) {
  // return game state
  res.send({
    gamestate: currentGameState,
    timer: timer
  })
});

app.delete('/', function(req, res, next) {
  // reset game
  // don't reset last id counters in case of floating clients trying to reuse them
  agents = {};
  customers = {};
  routes = {};
  ready = false;
});

// get agent info and ready status
app.get('/agents', function(req, res, next) {
  res.send(agents);
});

// Register a new agent
app.post('/agents', function(req, res, next) {
  agents[nextAgentId] = req.body;

  // set default agent name if not provided
  if (!agents[nextAgentId].name || agents[nextAgentId].name == "") {
    agents[nextAgentId].name = "Agent " + nextAgentId;
  }

  agents[nextAgentId].lastpingtime = new Date();
  agents[nextAgentId].active = true;
  agents[nextAgentId].playing = false;
  agents[nextAgentId].ready = false;

  // return agent id
  res.send({
    "id": nextAgentId,
    "name": agents[nextAgentId].name
  });
  nextAgentId++;
});

app.put('/agents/:id/ping', function(req, res, next) {
  if (agents[req.params.id] && agents[req.params.id].active) {
    agents[req.params.id].lastpingtime = new Date();
  } else {
    res.statusCode = 404;
  }
  res.send({
    "currentGameState": currentGameState,
    "timer": timer,
    "agents": agents,
    "customers": customers
  });
});

app.put('/agents/:id/ready', function(req, res, next) {
  // sets ready status of player id
  // if last registered agent to go ready then set endtime
  agents[req.params.id].ready = true;
  res.send();
});

app.get('/customers', function(req, res, next) {
  res.send(customers);
});

app.get('/customers/:id', function(req, res, next) {
  res.send(customers[req.param.id]);
});

app.get('/routes', function(req, res, next) {
  res.send(routes);
});

app.get('/providers', function(req, res, next) {
  res.send(providers);
});

app.put('/providers/:id/ping', function(req, res, next) {
  if (providers[req.params.id]) {
    providers[req.params.id].lastpingtime = new Date();
  } else {
    res.statusCode = 404;
  }
  res.send();
});

// Register a new provider
app.post('/providers', function(req, res, next) {
  providers[lastProviderId] = req.body;
  providers[lastProviderId].lastpingtime = new Date();
  providers[lastProviderId].lasterrcount = 0;
  providers[lastProviderId].active = true;
  providers[lastProviderId].routes = [];
  res.send({"id": lastProviderId});
  lastProviderId++;
});

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

app.use(function(err, req, res, next) {
  res.status(err.status || 500);
  res.send({"error": {
    message: err.message,
    error: err
  }});
});

app.listen(process.env.PORT);

module.exports = app;
