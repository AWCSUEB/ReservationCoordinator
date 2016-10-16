module.exports = {
    genCustRequests: function(n) {
        var letters = "ABCDEFGHIJKLMNOP";
        var requests = {};

        for (var i=0; i<n; i++) {
            do {
                var c1 = letters[parseInt(letters.length * Math.random())];
                var c2 = letters[parseInt(letters.length * Math.random())];
            } while (c1 == c2);

            if (!requests[c1 + c2]) {
                requests[c1 + c2] = {}
            } else {
                i--;
            }
        }

        return requests;
    },
    disconnectCount: function(agents, providers, playingOnly) {
        var i;
        var now;
        var last;
        var badAgents = [];
        var badProviders = [];

        for (var a in agents) {
            now = new Date().getTime();
            last = agents[a].lastpingtime.getTime();
            // check agent ping times
            if (now - last > 10000 && agents[a].active) {
                agents[a].lasterrcount++;

                if (!playingOnly || (agents[a].playing && playingOnly)) {
                    badAgents.push(a);
                }

                if (agents[a].lasterrcount > 4) {
                    console.log("Setting Agent " + a + " stale");
                    agents[a].active = false;
                }
            } else {
                agents[a].lasterrcount = 0;
            }
        }

        for (var p in providers) {
            now = new Date().getTime();
            last = providers[p].lastpingtime.getTime();
            // check agent ping times
            if (now - last > 10000 && providers[p].active) {
                providers[p].lasterrcount++;

                if (!playingOnly || (providers[p].playing && playingOnly)) {
                    badProviders.push(p);
                }

                if (providers[p].lasterrcount > 4) {
                    console.log("Setting Provider " + a + " stale");
                    providers[p].active = false;
                }
            } else {
                providers[p].lasterrcount = 0;
            }
        }

        return {"badAgents": badAgents, "badProviders": badProviders};
    },
    readyCount: function(agents, providers) {
        var agentList = Object.keys(agents);
        var providerList = Object.keys(providers);
        var i;

        var agentsReady = [];
        var agentsNotReady = [];
        for (i=0; i<agentList.length; i++) {
            var a = agents[agentList[i]];
            if (a.active) {
                if (a.ready) {
                    agentsReady.push(a);
                } else {
                    agentsNotReady.push(a);
                }
            }
        }

        var providersReady = [];
        var providersNotReady = [];
        for (i=0; i<providerList.length; i++) {
            var p = providers[providerList[i]];
            if (p.active) {
                if (p.lasterrcount == 0) {
                    providersReady.push(p);
                } else {
                    providersNotReady.push(p);
                }
            }
        }

        return {"agentsReady": agentsReady, "agentsNotReady": agentsNotReady, "providersReady": providersReady, "providersNotReady": providersNotReady};
    }
};