// server.js
// --------------------------------------------------
// Serveur du jeu SpiderGrow.io (optimisé anti-lag)
// - Express + Socket.IO
// - Tick serveur 20 FPS
// - Envoi "pellets" moins fréquent pour réduire le trafic
// - Colisions joueurs corrigées (bordures / kill)
// --------------------------------------------------

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);

// ⚡ Socket.IO : on force le WebSocket (meilleure latence sur Render)
const io = new Server(httpServer, {
  cors: { origin: "*" },
  transports: ["websocket"] // on n'autorise que le websocket
});

// On sert les fichiers statiques (front) dans /public
app.use(express.static("public"));

// --------------------------------------------------
// Constantes du jeu
// --------------------------------------------------
const MAP_WIDTH = 4000;
const MAP_HEIGHT = 4000;
const INITIAL_RADIUS = 25;
const RADIUS_PER_POINT = 0.6;
const MAX_PELLETS = 1200;

// socketId -> { x, y, score, radius, color, name }
const players = {};
let pellets = [];

// Compteur de ticks (sert pour envoyer moins souvent les pellets)
let tick = 0;

// --------------------------------------------------
// Utilitaires
// --------------------------------------------------
function randomInRange(min, max) {
  return Math.random() * (max - min) + min;
}

function randomPosition() {
  return {
    x: randomInRange(0, MAP_WIDTH),
    y: randomInRange(0, MAP_HEIGHT)
  };
}

// Palette de couleurs lisibles
function randomColor() {
  const colors = ["#00e5ff", "#ffb300", "#ff4081", "#b388ff", "#69f0ae"];
  return colors[Math.floor(Math.random() * colors.length)];
}

function generateInitialPellets(count = MAX_PELLETS) {
  pellets = [];
  for (let i = 0; i < count; i++) {
    const pos = randomPosition();
    pellets.push({
      id: i,
      x: pos.x,
      y: pos.y
    });
  }
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function sanitizeName(rawName) {
  if (typeof rawName !== "string") return "Anonyme";
  let name = rawName.trim();
  if (!name.length) return "Anonyme";
  if (name.length > 20) name = name.slice(0, 20);
  return name;
}

// --------------------------------------------------
// Boucle de jeu
// --------------------------------------------------
function gameLoop() {
  tick++;

  // 1) Joueur mange des pellets
  for (const [, player] of Object.entries(players)) {
    for (let i = pellets.length - 1; i >= 0; i--) {
      const p = pellets[i];
      if (!p) continue;

      if (distance(player, p) < player.radius + 5) {
        player.score += 1;
        player.radius = INITIAL_RADIUS + player.score * RADIUS_PER_POINT;
        pellets.splice(i, 1);
      }
    }
  }

  // 2) Joueur mange joueur (logique robuste même sur les bords)
  const ids = Object.keys(players);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = players[ids[i]];
      const b = players[ids[j]];
      if (!a || !b) continue;

      if (a.score === b.score) continue; // même score -> pas de kill

      // Le plus gros en score = mangeur potentiel
      let eaterId = a.score > b.score ? ids[i] : ids[j];
      let preyId = eaterId === ids[i] ? ids[j] : ids[i];

      const eater = players[eaterId];
      const prey = players[preyId];
      if (!eater || !prey) continue;

      const d = distance(eater, prey);
      const Re = eater.radius;
      const Rp = prey.radius;

      // Il faut un vrai écart de taille
      if (Re <= Rp * 1.05) continue;

      // Cas théorique : le petit entièrement dans le gros
      const fullContain = d + Rp <= Re;

      // Cas pratique : fort recouvrement (centre du petit bien "dans" le gros)
      const strongOverlap = d < Rp * 0.9;

      if (!fullContain && !strongOverlap) continue;

      // --- KILL ---
      const gained = Math.floor(prey.score * 0.5);
      eater.score += gained;
      eater.radius = INITIAL_RADIUS + eater.score * RADIUS_PER_POINT;

      const pos = randomPosition();
      players[preyId] = {
        x: pos.x,
        y: pos.y,
        score: 0,
        radius: INITIAL_RADIUS,
        color: prey.color,
        name: prey.name
      };

      io.to(eaterId).emit("youAtePlayer", {
        gained,
        victimName: prey.name
      });
      io.to(preyId).emit("youDied");
    }
  }

  // 3) Respawn progressif des pellets
  if (pellets.length < MAX_PELLETS && Math.random() < 0.2) {
    const pos = randomPosition();
    pellets.push({
      id: Date.now() + Math.random(),
      x: pos.x,
      y: pos.y
    });
  }

  // 4) Envoi de l'état au clients
  // ⚡ Optimisation anti-lag :
  //    - On envoie les joueurs à chaque tick (position & score = fluide)
  //    - On envoie les pellets seulement 1 tick sur 4 (~5 fois/sec)
  const payload = {
    players
  };

  if (tick % 4 === 0) {
    payload.pellets = pellets;
  }

  io.emit("state", payload);
}

// --------------------------------------------------
// Connexions Socket.IO
// --------------------------------------------------
io.on("connection", (socket) => {
  console.log("Player connected :", socket.id);

  const pos = randomPosition();
  players[socket.id] = {
    x: pos.x,
    y: pos.y,
    score: 0,
    radius: INITIAL_RADIUS,
    color: randomColor(),
    name: "Anonyme"
  };

  socket.emit("init", {
    id: socket.id,
    map: { width: MAP_WIDTH, height: MAP_HEIGHT }
  });

  socket.on("move", (data) => {
    const p = players[socket.id];
    if (!p) return;

    // On garde le joueur entièrement dans la map (bordures)
    const r = p.radius;
    p.x = Math.max(r, Math.min(MAP_WIDTH - r, data.x));
    p.y = Math.max(r, Math.min(MAP_HEIGHT - r, data.y));
  });

  socket.on("setName", (rawName) => {
    const p = players[socket.id];
    if (!p) return;
    p.name = sanitizeName(rawName);
    console.log(`➡️  Joueur ${socket.id} a choisi le pseudo : ${p.name}`);
  });

  socket.on("disconnect", () => {
    console.log("Player disconnected :", socket.id);
    delete players[socket.id];
  });
});

// --------------------------------------------------
// Lancement serveur
// --------------------------------------------------
generateInitialPellets(MAX_PELLETS);

// 20 FPS côté serveur (50 ms)
setInterval(gameLoop, 50);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});
