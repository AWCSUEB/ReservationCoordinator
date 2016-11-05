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
var nextProviderId = 1;

var routes = {};

// Each reservation should have
// ID
// Agent ID
// Customer ID
// Route list
// 2PC Status
var reservations = {};
var nextReservationId = 1;

var timer = timerDefault;
var timerHandle;
var resetCount = 0;

// game states
// NotReady: waiting for agents and sp to connect and ready
// Ready: all agents are ready
// Pending: loading customer list and routes
// Running: customer list and routes loaded
// Disconnected: waiting for a agent or sp to reconnect
var previousGameState = "Unknown";
var currentGameState = "NotReady";

console.log("PORT=" + process.env.PORT);

function setGameState(state) {
  previousGameState = currentGameState;
  currentGameState = state;
  console.log("GS=" + currentGameState + " PS=" + previousGameState);
}

function addRoutes(p) {
  return function (err, res, body) {
    var tmproutes = body;

    // load all route pairs e.g. AP,CF etc
    var routeslist = Object.keys(tmproutes);
    console.log("Provider " + p.name + ": Adding " + routeslist.join(","));

    // for each route in list push onto array for that pair
    for (var j = 0; j < routeslist.length; j++) {
      var pair = routeslist[j];
      if (!routes[pair]) {
        routes[pair] = [];
      }

      routes[pair].push(tmproutes[pair]);
      p.routes.push(tmproutes[pair]);
    }
  }
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
      for (var i=0; i<providerlist.length; i++) {
        var p = providers[providerlist[i]];
        p.playing = true;

        request({
          method: "POST",
          uri: p.uri + 'reset?n=' + routesToGen,
          json: true
        }, addRoutes(p));
      }

      // generate customer list
      customers = utility.genCustRequests(custsToGen);

      // mark playing agents
      for (var a in agents) {
        if (agents[a].ready) {
          agents[a].ready = false;
          agents[a].playing = true;
          agents[a].commission = 0;
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

  // Only pause game for disconnected SP, not for disconnected Agent unless all are bad
  if (dc.badProviders > 0 || dc.goodAgents == 0) {
    setGameState("Disconnected");
  }
}

function reconnectTest() {
  if (currentGameState != "Disconnected") {
    return;
  }

  var dc = utility.disconnectCount(agents, providers, currentGameState);

  // Only resume game for reconnected SP, not for bad Agents
  if (dc.badProviders == 0 && dc.goodAgents > 0) {
    setGameState("Running");
  } else {
    resetCount++;
    if (resetCount > 10) {
      timer = 0; // Trigger finishedTest
    }
  }
}

function finishedTest() {
  if (currentGameState != "Disconnected") {
    timer--;
  }

  if (currentGameState == "NotReady") {
    timer = 0;
  }

  if (timer == 0) {
    setGameState("NotReady");
    clearInterval(timerHandle);
    timer = timerDefault;
    customers = {};
    routes = {};
    reservations = {};
    resetCount = 0;

    for (var a in agents) {
      agents[a].playing = false;
    }

    for (var p in providers) {
      providers[p].playing = false;
      providers[p].routes = []
    }
  }
}

function cleanupTest() {
  var dc = utility.disconnectCount(agents, providers, currentGameState);
  var last;
  var now;

  for (var a in dc.badAgents) {
    last = agents[dc.badAgents[a]].lastpingtime;
    now = new Date().getTime();
    if (now - last > 10000) {
      if (currentGameState == "NotReady" || (currentGameState != "NotReady" && agents[dc.badAgents[a]].playing == false)) {
        console.log("*** Deleting " + agents[dc.badAgents[a]].name + " ***");
        delete agents[dc.badAgents[a]];
      }
    }
  }

  for (var p in dc.badProviders) {
    last = providers[dc.badProviders[p]].lastpingtime;
    now = new Date().getTime();
    if (now - last > 10000) {
      if (currentGameState == "NotReady") {
        console.log("*** Deleting " + providers[dc.badProviders[p]].name + " ***");
        delete providers[dc.badProviders[p]];
      }
    }
  }
}

function reservationTest() {
  if (currentGameState != "Running") {
    return;
  }

  var route;
  var p;

  for (var re in reservations) {
    if (reservations[re].status == "CancelReady") {
      reservations[re].status = "Cancelling";
      reservations[re].left = Object.keys(reservations[re].routes).length;

      for (route in reservations[re].routes) {
        p = providers[reservations[re].routes[route].spid];
        request({
          method: 'PUT',
          uri: p.uri + 'cancel/' + route,
          timeout: 30000,
          body: {
            id: re
          },
          json: true
        }, function (err, res, body) {
          var id = body.id;
          var route = body.route;

          if (err) {
            console.log("[CANCEL FAILED] Reservation " + id + ", Route " + route + ": " + err.message);
          }

          reservations[id].left--;

          if (reservations[id].left == 0) {
            reservations[id].status = "Cancelled";
            console.log("[CANCELLED] Reservation " + id);
          }
        });
      }
    }

    if (reservations[re].status == "ConfirmReady") {
      reservations[re].status = "Confirming";
      reservations[re].left = Object.keys(reservations[re].routes).length;

      for (route in reservations[re].routes) {
        p = providers[reservations[re].routes[route].spid];
        request({
          method: 'PUT',
          uri: p.uri + 'confirm/' + route,
          timeout: 30000,
          body: {
            id: re
          },
          json: true
        }, function (err, res, body) {
          var id = body.id;
          var route = body.route;

          if (err) {
            console.log("[CONFIRM FAILED] Reservation " + id + ", Route " + route + ": " + err.message);
          }

          reservations[id].left--;
          if (reservations[id].left == 0) {
            reservations[id].status = "Committed";
            console.log("[CONFIRMED] Reservation " + id);

            var customer = customers[reservations[id].customerid];

            // reset the best overall cost
            if (customer.bestcost == 0 ||
                reservations[id].cost < customer.bestcost) {
              customer.bestcost = reservations[id].cost;
              customer.bestcostagentid = reservations[id].agentid;
              customer.bestcostreservationid = id;
            }

            // init agent best cost
            if (!customer.bestagentcost[reservations[id].agentid]) {
              customer.bestagentcost[reservations[id].agentid] = 0;
            }

            // reset the agent's best cost
            if (customer.bestagentcost[reservations[id].agentid] == 0 ||
                reservations[id].cost < customer.bestagentcost[reservations[id].agentid]) {
              customer.bestagentcost[reservations[id].agentid] = reservations[id].cost;
            }

            // remove reservation routes and add replacement routes
            for (route in reservations[id].routes) {
              if (routes[route].length == 1) {
                delete routes[route];
              } else {
                delete routes[route][0];
              }
              p = providers[reservations[re].routes[route].spid];
              request({
                method: 'POST',
                uri: p.uri + 'add/1',
                timeout: 30000,
                json: true
              }, addRoutes(p));
            }
          }
        });
      }

    }
  }
}

setInterval(readyTest, 1000);
setInterval(runningTest, 1000);
setInterval(disconnectTest, 1000);
setInterval(reconnectTest, 1000);
setInterval(cleanupTest, 1000);
setInterval(reservationTest, 1000);

// CORS
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
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
  agents[nextAgentId].commission = 0;

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
    "customers": customers,
    "providers": providers,
    "reservations": reservations
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
  providers[nextProviderId] = req.body;
  providers[nextProviderId].lastpingtime = new Date();
  providers[nextProviderId].lasterrcount = 0;
  providers[nextProviderId].active = true;
  providers[nextProviderId].playing = false;
  providers[nextProviderId].routes = [];
  res.send({"id": nextProviderId});
  nextProviderId++;
});

app.get('/reservations', function(req, res, next) {
  res.send(reservations);
});

app.get('/reservations/:id', function(req, res, next) {
  if (reservations[req.params.id]) {
    res.send(reservations[req.params.id]);
  } else {
    res.statusCode = 404;
    res.send();
  }
});

// Submit a new reservation transaction
app.post('/reservations', function(req, res, next) {
  // Send ajax request of each route component to the respective SP
  // Requires agent id, customer id, route list
  // each route has spid, c1, c2, cost
  var routes = req.body.routes;
  reservations[nextReservationId] = req.body;
  reservations[nextReservationId].status = "Trying";
  reservations[nextReservationId].left = Object.keys(req.body.routes).length;
  reservations[nextReservationId].cost = 0;

  for (var r in routes) {
    reservations[nextReservationId].cost += routes[r].cost;
    var p = providers[routes[r].spid];
    console.log("Reservation " + nextReservationId + " request: " + p.uri + "try/" + r);
    request({
      method: 'PUT',
      uri: p.uri + 'try/' + r,
      timeout: 30000,
      body: {
        id: nextReservationId
      },
      json: true
    }, function (err, res, body) {
      var id = body.id;
      console.log("Reservation " + id + " response");
      if (reservations[id].status == "Trying") {
        if (!err && res.statusCode == 200) {
          // if all tries are successful let another timed function process commit
          reservations[id].left--;
          if (reservations[id].left == 0) {
            reservations[id].status = "ConfirmReady";
            console.log("[CONFIRM READY] Reservation " + id);
          }
        } else {
          // set a failed status and let another timed function process cancel
          reservations[id].status = "CancelReady";
          console.log("[CANCEL READY] Reservation " + id);
        }
      }
    });
  }

  res.send({
    id: nextReservationId
  });
  nextReservationId++;
});

app.get('/routes', function(req, res, next) {
  res.send(routes);
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

module.exports = app;
