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

var custsToGen = process.env.CUSTSTOGEN || 8;
var routesToGen = process.env.ROUTESTOGEN || 24;
var timerDefault = process.env.TIMERDEFAULT || 180;
var deleteAgentTimer = process.env.DELETEAGENTTIMER || 10000;
var deleteProviderTimer = process.env.DELETEPROVIDERTIMER || 10000;
var commissionRatio = process.env.COMMISSIONRATIO || .10;
var penaltyAmount = process.env.PENALTYAMOUNT || 5;
var readyTimeout = process.env.READYTIMEOUT || 15;

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

var messagesForAgent = {};

var timer = timerDefault;
var timerHandle;
var resetCount = 0;

var prevAgentsReady;
var prevProvidersReady;
var prevAgentsNotReady;
var prevProvidersNotReady;
var readyTimeoutCounter = readyTimeout;

// game states
// NotReady: waiting for agents and sp to connect and ready
// Ready: all agents are ready
// Pending: loading customer list and routes
// Running: customer list and routes loaded
// Disconnected: waiting for a agent or sp to reconnect
var previousGameState = "Unknown";
var currentGameState = "NotReady";

app.set("port", process.env.PORT);

console.log("CUSTSTOGEN=" + process.env.CUSTSTOGEN);
console.log("ROUTESTOGEN=" + process.env.ROUTESTOGEN);
console.log("TIMERDEFAULT=" + process.env.TIMERDEFAULT);
console.log("DELETEAGENTTIMER=" + process.env.DELETEAGENTTIMER);
console.log("DELETEPROVIDERTIMER=" + process.env.DELETEPROVIDERTIMER);
console.log("COMMISSIONRATIO=" + process.env.COMMISSIONRATIO);
console.log("PENALTYAMOUNT=" + process.env.PENALTYAMOUNT);
console.log("READYTIMEOUT=" + process.env.READYTIMEOUT);

function broadcastMessage(source, message) {
  for (var m in messagesForAgent) {
    messagesForAgent[m].push("[" + source + "] " + message);
  }
}

function broadcastMessageToAgent(source, message, agentid) {
  messagesForAgent[agentid].push("[" + source + "] " + message);
}

function setGameState(state) {
  previousGameState = currentGameState;
  currentGameState = state;
  broadcastMessage("RC", "Current Game State: " + currentGameState);
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
  if (!(prevAgentsReady == rc.agentsReady.length &&
      prevProvidersReady == rc.providersReady.length &&
      prevAgentsNotReady == rc.agentsNotReady.length &&
      prevProvidersNotReady == rc.providersNotReady) || readyTimeoutCounter < readyTimeout) {
    prevAgentsReady = rc.agentsReady.length;
    prevProvidersReady = rc.providersReady.length;
    prevAgentsNotReady = rc.agentsNotReady.length;
    prevProvidersNotReady = rc.providersNotReady.length;
    if (readyTimeoutCounter == readyTimeout) {
      console.log("AR=" + rc.agentsReady.length + " PR=" + rc.providersReady.length + " ANR=" + rc.agentsNotReady.length + " PNR=" + rc.providersNotReady.length);
    }

    if (!(rc.providersReady.length > 0 && rc.providersNotReady.length == 0)) {
      broadcastMessage("RC", "Waiting for SPs");

      for (var p in providers) {
        providers[p].playing = false;
      }

      readyTimeoutCounter = readyTimeout;
    } else {
      if (rc.agentsReady.length > 0) {
        if ((rc.agentsReady.length > 1 && rc.agentsNotReady.length == 0) || readyTimeoutCounter == 0) {
          if (rc.agentsNotReady.length == 0) {
            broadcastMessage("RC", "Starting game with all agents");
          } else {
            broadcastMessage("RC", "Starting game with only agents marked ready");
          }

          setGameState("Ready");
          customers = {};
          for (var a in agents) {
            agents[a].commission = 0;
          }

          setTimeout(function () {
            // reset and collect routes from service providers
            var providerlist = Object.keys(providers);
            for (var i = 0; i < providerlist.length; i++) {
              var p = providers[providerlist[i]];
              p.playing = true;

              var myRoutesToGen = routesToGen / providerlist.length;

              request({
                method: "POST",
                uri: p.uri + 'reset?n=' + myRoutesToGen,
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
              }
            }

            // client will start polling ready frequently and will grab routes and customer list when available
            setGameState("Pending");
          }, 3000);
        } else {
          if (readyTimeoutCounter % 5 == 0 || readyTimeoutCounter <= 5) {
            broadcastMessage("RC", "Starting in " + readyTimeoutCounter);
          }
          readyTimeoutCounter--;
        }
      } else {
        for (var a in agents) {
          agents[a].playing = false;
        }
      }
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
    var myRoutesToGen = routesToGen / providerList.length;
    if (p.routes.length == myRoutesToGen) {
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
    for (var p in dc.badProviders) {
      if (providers[dc.badProviders[p]].playing) { // only disconnected state if playing provider disconnects
        setGameState("Disconnected");
      }
    }
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
    routes = {};
    reservations = {};
    nextReservationId = 1;
    resetCount = 0;
    readyTimeoutCounter = readyTimeout;

    var topAgents = [];
    var topCommission = 0;

    for (var a in agents) {
      agents[a].playing = false;
      if (agents[a].commission > topCommission) {
        topAgents = [];
        topAgents.push(agents[a]);
        topCommission = agents[a].commission;
      } else if (agents[a].commission == topCommission) {
        topAgents.push(agents[a]);
      }
    }

    if (previousGameState != "Disconnected") {
      if (topCommission > 0) {
        broadcastMessage("RC", topAgents.map(function (el) {
              return el.name;
            }).join(", ") + " Wins with $" + parseFloat(topCommission).toFixed(2) + " !!!");
      } else {
        broadcastMessage("RC", "No Winner: Game Reset");
      }
    } else {
      broadcastMessage("RC", "SP Timeout: Game Reset");
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
    if (now - last > deleteAgentTimer) {
      if (currentGameState == "NotReady" || (currentGameState != "NotReady" && agents[dc.badAgents[a]].playing == false)) {
        console.log("*** Deleting " + agents[dc.badAgents[a]].name + " ***");
        delete agents[dc.badAgents[a]];
      }
    }
  }

  for (var p in dc.badProviders) {
    last = providers[dc.badProviders[p]].lastpingtime;
    now = new Date().getTime();
    if (now - last > deleteProviderTimer) {
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
            broadcastMessageToAgent("RC", "Cancelled Reservation for Route " + route, reservations[id].agentid);
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
            var customer = customers[reservations[id].customerid];

            // reset the best overall hops and cost
            if ((customer.besthopsandcost.hops == 0 && customer.besthopsandcost.cost == 0) ||
                (reservations[id].hops > customer.besthopsandcost.hops) ||
                (reservations[id].hops == customer.besthopsandcost.hops && reservations[id].cost < customer.besthopsandcost.cost)) {
              customer.besthopsandcost.hops = reservations[id].hops;
              customer.besthopsandcost.cost = reservations[id].cost;
              customer.besthopsandcostagentid = reservations[id].agentid;
              customer.besthopsandcostreservationid = id;
            }

            // init agent best hops and cost
            if (!customer.bestagenthopsandcost[reservations[id].agentid]) {
              customer.bestagenthopsandcost[reservations[id].agentid] = {hops: 0, cost: 0, count: 0};
            }

            // reset the agent's best hops and cost
            if ((customer.bestagenthopsandcost[reservations[id].agentid].hops == 0 && customer.bestagenthopsandcost[reservations[id].agentid].cost == 0) ||
                (reservations[id].hops > customer.bestagenthopsandcost[reservations[id].agentid].hops) ||
                (reservations[id].hops == customer.bestagenthopsandcost[reservations[id].agentid].hops && reservations[id].cost < customer.bestagenthopsandcost[reservations[id].agentid].cost)) {
              customer.bestagenthopsandcost[reservations[id].agentid].hops = reservations[id].hops;
              customer.bestagenthopsandcost[reservations[id].agentid].cost = reservations[id].cost;
              customer.bestagenthopsandcost[reservations[id].agentid].count++;
            }

            // remove reservation routes and add replacement routes
            for (route in reservations[id].routes) {
              if (routes[route].length == 1) {
                delete routes[route];
              } else {
                routes[route].splice(0, 1);
              }
              p = providers[reservations[re].routes[route].spid];
              request({
                method: 'POST',
                uri: p.uri + 'add/1',
                timeout: 30000,
                json: true
              }, addRoutes(p));
            }

            // update commission schedule for each agent
            for (var a in agents) {
              agents[a].commission = 0;
            }

            for (var c in customers) {
              if (customers[c].besthopsandcostagentid != 0) {
                // 10% commission - $5 for each rebooking
                var commission = customers[c].besthopsandcost.cost * commissionRatio;
                var penalty = penaltyAmount * (customers[c].bestagenthopsandcost[customers[c].besthopsandcostagentid].count - 1);
                agents[customers[c].besthopsandcostagentid].commission += commission - penalty;
              }
            }

            reservations[id].status = "Committed";
            console.log("[CONFIRMED] Reservation " + id);
            broadcastMessageToAgent("RC", "Confirmed Reservation for Route " + reservations[id].customerid, reservations[id].agentid);
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
    gameState: currentGameState,
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
  agents[nextAgentId].pingId = 0;

  messagesForAgent[nextAgentId] = [];

  // return agent id
  broadcastMessage("RC", req.body.name + " (" + nextAgentId + ") Connected");
  broadcastMessageToAgent("RC", "Current Game State: " + currentGameState, nextAgentId);
  res.send({
    "id": nextAgentId,
    "name": agents[nextAgentId].name,
    "commissionRatio": commissionRatio,
    "penaltyAmount": penaltyAmount
  });
  nextAgentId++;
});

app.post('/agents/:id/chat', function(req, res, next) {
  broadcastMessage(agents[req.params.id].name, req.body.message);
  res.send({});
});

app.put('/agents/:id/ping', function(req, res, next) {
  if (agents[req.params.id] && agents[req.params.id].active) {
    agents[req.params.id].lastpingtime = new Date();
  } else {
    res.statusCode = 404;
  }

  var agentPingId = parseInt(agents[req.params.id].pingId);
  if (req.body.pingId == agentPingId + 1) {
    agents[req.params.id].pingId = req.body.pingId;
  }

  res.send({
    "currentGameState": currentGameState,
    "timer": timer,
    "agents": agents,
    "customers": customers,
    "providers": providers,
    "messages": messagesForAgent[req.params.id]
  });

  if (req.body.pingId == agentPingId + 1) {
    messagesForAgent[req.params.id] = [];
  }
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
  console.log(req.body.name + " @ " + req.body.uri);
  broadcastMessage("RC", req.body.name + " Connected");
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
  reservations[nextReservationId].hops = 0;
  reservations[nextReservationId].cost = 0;

  for (var r in routes) {
    reservations[nextReservationId].hops += 1;
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
