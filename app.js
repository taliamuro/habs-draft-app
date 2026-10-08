const CONFIG = {
    team: "MTL",
    gameType: 2,
    refreshMs: 5 * 60 * 1000,

    scoring: {
        goals: 2,
        assists: 1,
        hits: 0.5,
        hatTricks: 4,
        shortHandedAssists: 2,
        shortHandedGoals: 3,
        giveaways: -0.5
    }
};

const teams = {
    talia: {
        name: "Talia",

        players: [
            "Nick Suzuki",
            "Juraj Slafkovsky",
            "Ivan Demidov",
            "Zachary Bolduc",
            "Lane Hutson",
            "Mike Matheson"
        ],

        reserve: [
            "Chris Kreider",
            "Kaiden Guhle"
        ]
    },

    mathias: {
        name: "Mathias",

        players: [
            "Cole Caufield",
            "Josh Anderson",
            "Alex Newhook",
            "Jake Evans",
            "Noah Dobson",
            "Arber Xhekaj"
        ],

        reserve: [
            "Kirby Dach",
            "Alexandre Carrier"
        ]
    }
};

const API = "https://api-web.nhle.com/v1";
const PROXY = "https://YOUR-WORKER.workers.dev/?url=";

const COLS = [
    ["gp", "GP"],
    ["goals", "G"],
    ["assists", "A"],
    ["hits", "Hits"],
    ["hatTricks", "HT"],
    ["shortHandedAssists", "SHA"],
    ["shortHandedGoals", "SHG"],
    ["giveaways", "GA"]
];

/*
    * Converts names into a normalized format.
    *
    * Example:
    * "Nick Suzuki" -> "nick suzuki"
    * "N. Suzuki"   -> "n suzuki"
    */
const norm = (s) =>
    s
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z ]/g, " ")
        .trim();

/*
    * Creates a key using the player's first initial
    * and surname.
    *
    * Example:
    * "Nick Suzuki" -> "n suzuki"
    */
const keyOf = (n) => {
    const p = norm(n)
        .split(/\s+/)
        .filter(Boolean);

    return p[0][0] + " " + p.slice(1).join(" ");
};

const blank = () => ({
    gp: 0,
    goals: 0,
    assists: 0,
    hits: 0,
    hatTricks: 0,
    shortHandedAssists: 0,
    shortHandedGoals: 0,
    giveaways: 0
});

let totals = {};
let lastOk = null;
let busy = false;

const cacheKey = "habs-games-v1";

let cache = {};

try {
    cache = JSON.parse(
        localStorage.getItem(cacheKey) || "{}"
    );
} catch (e) {
    cache = {};
}

const J = async (u) => {
    const r = await fetch(
        PROXY + encodeURIComponent(u)
    );

    if (!r.ok) {
        throw new Error(r.status);
    }

    return r.json();
};

async function gameStats(g) {
    const [box, pbp] = await Promise.all([
        J(`${API}/gamecenter/${g.id}/boxscore`),
        J(`${API}/gamecenter/${g.id}/play-by-play`)
    ]);

    const mtlHome =
        box.homeTeam.abbrev === CONFIG.team;

    const side = mtlHome
        ? "homeTeam"
        : "awayTeam";

    const mtlId = box[side].id;

    const ps = box.playerByGameStats[side];

    const out = {};
    const idKey = {};

    [
        ...(ps.forwards || []),
        ...(ps.defense || [])
    ].forEach((p) => {
        const k = keyOf(p.name.default);

        idKey[p.playerId] = k;

        const o = blank();

        o.gp = 1;
        o.goals = p.goals || 0;
        o.assists = p.assists || 0;
        o.hits = p.hits || 0;
        o.giveaways = p.giveaways || 0;
        o.hatTricks = o.goals >= 3 ? 1 : 0;

        out[k] = o;
    });

    (pbp.plays || []).forEach((pl) => {
        if (
            pl.typeDescKey !== "goal" ||
            !pl.details ||
            pl.details.eventOwnerTeamId !== mtlId
        ) {
            return;
        }

        const sc = String(
            pl.situationCode || ""
        ).padStart(4, "0");

        const away = +sc[1];
        const home = +sc[2];

        const sh = mtlHome
            ? home < away
            : away < home;

        if (!sh) {
            return;
        }

        const d = pl.details;

        if (idKey[d.scoringPlayerId]) {
            out[
                idKey[d.scoringPlayerId]
            ].shortHandedGoals++;
        }

        [
            d.assist1PlayerId,
            d.assist2PlayerId
        ].forEach((id) => {
            if (id && idKey[id]) {
                out[idKey[id]]
                    .shortHandedAssists++;
            }
        });
    });

    return out;
}

async function refresh() {
    if (busy) {
        return;
    }

    busy = true;

    setStatus("load", "Updating…");

    try {
        const sched = await J(
            `${API}/club-schedule-season/${CONFIG.team}/now`
        );

        const games = sched.games.filter(
            (g) =>
                g.gameType === CONFIG.gameType &&
                [
                    "FINAL",
                    "OFF",
                    "LIVE",
                    "CRIT"
                ].includes(g.gameState)
        );

        const todo = games.filter(
            (g) =>
                !cache[g.id] ||
                !["FINAL", "OFF"].includes(
                    cache[g.id].state
                )
        );

        for (let i = 0; i < todo.length; i += 4) {
            await Promise.all(
                todo
                    .slice(i, i + 4)
                    .map(async (g) => {
                        cache[g.id] = {
                            state: g.gameState,
                            stats: await gameStats(g)
                        };
                    })
            );
        }

        const live = {};

        games.forEach((g) => {
            live[g.id] = 1;
        });

        Object.keys(cache).forEach((id) => {
            if (!live[id]) {
                delete cache[id];
            }
        });

        try {
            localStorage.setItem(
                cacheKey,
                JSON.stringify(cache)
            );
        } catch (e) {}

        totals = {};

        Object.values(cache).forEach((c) => {
            Object.entries(c.stats).forEach(
                ([k, s]) => {
                    const t =
                        totals[k] =
                        totals[k] || blank();

                    for (const f in s) {
                        t[f] += s[f];
                    }
                }
            );
        });

        lastOk = new Date();

        setStatus(
            "ok",
            "Live NHL data • " +
                lastOk.toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit"
                }) +
                " • " +
                games.length +
                " GP"
        );
    } catch (e) {
        setStatus(
            "",
            "NHL data unavailable — tap to retry"
        );

        console.error(e);
    }

    busy = false;

    render();
}

function setStatus(c, t) {
    const p = document.getElementById("status");

    p.className = "pill " + c;

    document.getElementById("stxt").textContent = t;
}

const get = (n) =>
    Object.assign(
        blank(),
        totals[keyOf(n)] || {}
    );

const pts = (s) => {
    const c = CONFIG.scoring;

    return (
        s.goals * c.goals +
        s.assists * c.assists +
        s.hits * c.hits +
        s.hatTricks * c.hatTricks +
        s.shortHandedAssists *
            c.shortHandedAssists +
        s.shortHandedGoals *
            c.shortHandedGoals +
        s.giveaways * c.giveaways
    );
};

const fmt = (x) =>
    String(Math.round(x * 10) / 10);

function el(t, c, x) {
    const e = document.createElement(t);

    if (c) {
        e.className = c;
    }

    if (x != null) {
        e.textContent = x;
    }

    return e;
}

function render() {
    const tot = {};

    for (const k in teams) {
        tot[k] = teams[k].players.reduce(
            (t, n) => t + pts(get(n)),
            0
        );
    }

    const lead =
        tot.talia === tot.mathias
            ? null
            : tot.talia > tot.mathias
                ? "talia"
                : "mathias";

    const sc =
        document.getElementById("score");

    sc.textContent = "";

    for (const k in teams) {
        const o =
            k === "talia"
                ? "mathias"
                : "talia";

        const d = el(
            "div",
            "sc" + (lead === k ? " lead" : "")
        );

        d.append(
            el("div", "n", teams[k].name),
            el("div", "p", fmt(tot[k])),
            el(
                "div",
                "t",
                lead === k
                    ? "Leading by " +
                            fmt(tot[k] - tot[o])
                    : lead
                        ? ""
                        : "Tied"
            )
        );

        sc.appendChild(d);
    }

    const r =
        document.getElementById("rules");

    r.textContent = "";

    [
        ["Goal", "goals"],
        ["Assist", "assists"],
        ["Hit", "hits"],
        ["Hat trick", "hatTricks"],
        ["SH assist", "shortHandedAssists"],
        ["SH goal", "shortHandedGoals"],
        ["Giveaway", "giveaways"]
    ].forEach(([l, k]) => {
        const v = CONFIG.scoring[k];

        r.appendChild(
            el(
                "span",
                null,
                l + " " + (v > 0 ? "+" : "") + v
            )
        );
    });

    const tb =
        document.getElementById("tables");

    tb.textContent = "";

    for (const k in teams) {
        const card = el("div", "tc");

        card.appendChild(
            el(
                "h2",
                null,
                teams[k].name + "'s Team"
            )
        );

        const sx = el("div", "sx");
        const t = el("table");
        const hr = el("tr");

        hr.appendChild(
            el("th", null, "Player")
        );

        COLS.forEach((c) =>
            hr.appendChild(
                el("th", null, c[1])
            )
        );

        hr.appendChild(
            el("th", null, "Pts")
        );

        const th = el("thead");

        th.appendChild(hr);
        t.appendChild(th);

        const body = el("tbody");
        const sum = blank();

        const row = (n, res) => {
            const s = get(n);

            const tr = el(
                "tr",
                res ? "res" : ""
            );

            tr.appendChild(
                el("td", null, n)
            );

            COLS.forEach(([f]) => {
                const td = el(
                    "td",
                    null,
                    s[f]
                );

                tr.appendChild(td);

                if (!res && f !== "gp") {
                    sum[f] += s[f];
                }
            });

            const p = pts(s);

            const td = el(
                "td",
                "pts" + (p < 0 ? " neg" : ""),
                fmt(p)
            );

            tr.appendChild(td);

            body.appendChild(tr);
        };

        teams[k].players.forEach((n) =>
            row(n, false)
        );

        const tr = el("tr", "tot");

        tr.appendChild(
            el("td", null, "Team total")
        );

        COLS.forEach(([f]) =>
            tr.appendChild(
                el(
                    "td",
                    null,
                    f === "gp" ? "" : sum[f]
                )
            )
        );

        tr.appendChild(
            el(
                "td",
                "pts",
                fmt(tot[k])
            )
        );

        body.appendChild(tr);

        const sep = el("tr", "sep");

        const sd = el(
            "td",
            null,
            "Reserves (not counted)"
        );

        sd.colSpan = COLS.length + 2;

        sep.appendChild(sd);
        body.appendChild(sep);

        teams[k].reserve.forEach((n) =>
            row(n, true)
        );

        t.appendChild(body);
        sx.appendChild(t);
        card.appendChild(sx);
        tb.appendChild(card);
    }

    document.getElementById("note").textContent =
        "Regular-season games only. Stats come from the NHL's public boxscore and play-by-play data and refresh every 5 minutes. Hat tricks and short-handed goals/assists are bonuses on top of the normal goal and assist points.";
}

document.getElementById("status").onclick =
    refresh;

render();
refresh();

setInterval(
    refresh,
    CONFIG.refreshMs
);