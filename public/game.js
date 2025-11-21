// game.js
// --------------------------------------------------
// Client du jeu SpiderGrow.io (optimisé anti-lag)
// --------------------------------------------------

// ⚡ Connexion Socket.IO : on force le WebSocket
const socket = io({
  transports: ["websocket"],
  upgrade: false
});

let myId = null;
let mapInfo = null;
let state = { players: {}, pellets: [] };

// Vitesse : petit = rapide, gros = lent
const MAX_SPEED = 700;
const MIN_SPEED = 320;

// HUD
const scoreEl = document.getElementById("score");
const leaderboardEl = document.getElementById("leaderboard");

// Overlay pseudo
const nameOverlay = document.getElementById("name-overlay");
const nameInput = document.getElementById("playerNameInput");
const startButton = document.getElementById("startButton");
const nameError = document.getElementById("name-error");

let playerName = null;
let canMove = false;
let lastScore = 0;

// Référence globale sur la scène pour jouer les sons dans les callbacks
window.currentScene = null;

// --------------------------------------------------
// Gestion pseudo
// --------------------------------------------------
function submitName() {
  const raw = nameInput.value.trim();

  if (raw.length === 0) {
    nameError.textContent = "Merci d'entrer un pseudo.";
    return;
  }

  const name = raw.slice(0, 20);
  playerName = name;

  // Envoi au serveur
  socket.emit("setName", playerName);

  nameOverlay.style.display = "none";
  nameError.textContent = "";
  canMove = true;

  // On lance l'ambiance si elle existe
  if (
    window.currentScene &&
    window.currentScene.ambience &&
    !window.currentScene.ambience.isPlaying
  ) {
    window.currentScene.ambience.play();
  }
}

startButton.addEventListener("click", submitName);
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitName();
});

// --------------------------------------------------
// Socket.IO
// --------------------------------------------------
socket.on("connect", () => {
  console.log("✅ Connecté au serveur, id socket.io :", socket.id);
});

socket.on("init", (data) => {
  console.log("📥 init reçu :", data);
  myId = data.id;
  mapInfo = data.map;
});

// ⚡ On accepte maintenant un état partiel : parfois seulement players,
// parfois players + pellets (pour réduire le trafic).
socket.on("state", (serverState) => {
  if (serverState.players) {
    state.players = serverState.players;
  }
  if (serverState.pellets) {
    state.pellets = serverState.pellets;
  }

  const me = state.players[myId];

  if (me) {
    scoreEl.textContent = me.score;

    // Son quand le score augmente
    if (me.score > lastScore) {
      if (window.currentScene && window.currentScene.eatSound) {
        window.currentScene.eatSound.play();
      }
    }
    lastScore = me.score;
  } else {
    lastScore = 0;
  }

  updateLeaderboard();
});

socket.on("youDied", () => {
  console.log("☠️ Tu es mort");
  canMove = false;

  // Retour écran pseudo (on peut garder ou changer le nom)
  if (nameOverlay) nameOverlay.style.display = "flex";
  if (nameInput) nameInput.value = playerName || "";
  if (nameError) nameError.textContent = "";
});

socket.on("youAtePlayer", (data) => {
  console.log(
    `🍽️ Tu as mangé ${data.victimName || "un joueur"} et gagné ${data.gained
    } points`
  );
});

// --------------------------------------------------
// Leaderboard
// --------------------------------------------------
function updateLeaderboard() {
  if (!leaderboardEl || !state.players) return;

  const entries = Object.entries(state.players);
  if (entries.length === 0) {
    leaderboardEl.innerHTML = "<strong>Top 10</strong><br/>Aucun joueur";
    return;
  }

  entries.sort((a, b) => b[1].score - a[1].score);

  const top = entries.slice(0, 10);
  let html = "<strong>Top 10</strong>";

  top.forEach(([id, p], index) => {
    const isMe = id === myId;
    const displayName = p.name || `Joueur ${id.slice(0, 4)}`;
    const name = isMe ? `${displayName} (vous)` : displayName;
    html += `<div>${index + 1}. ${name} — ${p.score} pts</div>`;
  });

  const myIndex = entries.findIndex(([id]) => id === myId);
  if (myIndex >= 10) {
    const me = entries[myIndex][1];
    const displayName = me.name || "Vous";
    html += `<hr/><div><strong>Votre position :</strong> ${myIndex + 1
      }e — ${displayName} — ${me.score} pts</div>`;
  }

  leaderboardEl.innerHTML = html;
}

// --------------------------------------------------
// Scène Phaser
// --------------------------------------------------
class SpiderScene extends Phaser.Scene {
  constructor() {
    super("SpiderScene");
  }

  preload() {
    // On essaie de charger les sons, mais s'ils n'existent pas
    // on ne les utilisera pas (pas de crash).
    this.load.audio("ambience", "assets/ambience.mp3");
    this.load.audio("eat", "assets/eat.mp3");
  }

  create() {
    window.currentScene = this;

    // Fond hexagonal
    this.bgGraphics = this.add.graphics();
    this.drawHexBg();

    // Calques pour les points & joueurs
    this.pelletGraphics = this.add.graphics();
    this.playerGraphics = this.add.graphics();

    // Textes des pseudos
    this.nameTexts = {};

    // Contrôles clavier
    this.cursors = this.input.keyboard.createCursorKeys();
    // ZQSD (clavier FR)
    this.keysZQSD = this.input.keyboard.addKeys("Z,Q,S,D");

    // Touche M pour mute
    this.keyMute = this.input.keyboard.addKey(
      Phaser.Input.Keyboard.KeyCodes.M
    );

    // Caméra
    this.cameras.main.setBounds(0, 0, 4000, 4000);

    // Sons (créés seulement si le cache les contient)
    if (this.cache.audio.exists("ambience")) {
      this.ambience = this.sound.add("ambience", {
        loop: true,
        volume: 0.4
      });
    } else {
      this.ambience = null;
      console.warn("Ambience audio not found, pas de musique de fond.");
    }

    if (this.cache.audio.exists("eat")) {
      this.eatSound = this.sound.add("eat", { volume: 0.7 });
    } else {
      this.eatSound = null;
      console.warn("Eat audio not found, pas de son de points.");
    }

    console.log("🎮 Scene créée");
  }

  drawHexBg() {
    const g = this.bgGraphics;
    g.clear();
    g.lineStyle(1, 0x222222, 1);

    const size = 40;
    const w = 4000;
    const h = 4000;
    const hexHeight = size * Math.sqrt(3);

    for (let y = 0; y < h + hexHeight; y += hexHeight) {
      for (let x = 0; x < w + size * 1.5; x += size * 1.5) {
        const offsetX = (Math.floor(y / hexHeight) % 2) * (size * 0.75);
        this.drawHex(x + offsetX, y, size);
      }
    }
  }

  drawHex(cx, cy, size) {
    const g = this.bgGraphics;
    const points = [];
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i;
      points.push({
        x: cx + size * Math.cos(angle),
        y: cy + size * Math.sin(angle)
      });
    }
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      g.lineTo(points[i].x, points[i].y);
    }
    g.closePath();
    g.strokePath();
  }

  update(time, delta) {
    const me = state.players[myId];

    // M pour mute/unmute
    if (Phaser.Input.Keyboard.JustDown(this.keyMute)) {
      this.sound.mute = !this.sound.mute;
    }

    // Mouvement uniquement si le joueur est prêt
    if (me && mapInfo && canMove) {
      let vx = 0;
      let vy = 0;

      // ZQSD + flèches
      if (this.cursors.left.isDown || this.keysZQSD.Q.isDown) vx -= 1;
      if (this.cursors.right.isDown || this.keysZQSD.D.isDown) vx += 1;
      if (this.cursors.up.isDown || this.keysZQSD.Z.isDown) vy -= 1;
      if (this.cursors.down.isDown || this.keysZQSD.S.isDown) vy += 1;

      const len = Math.hypot(vx, vy);
      if (len > 0) {
        vx /= len;
        vy /= len;
      }

      const maxRadius = 220;
      const r = Math.min(me.radius, maxRadius);
      const t = r / maxRadius;
      const speed = MAX_SPEED - t * (MAX_SPEED - MIN_SPEED);

      const dt = delta / 1000;
      const newX = me.x + vx * speed * dt;
      const newY = me.y + vy * speed * dt;

      socket.emit("move", { x: newX, y: newY });
      this.cameras.main.startFollow(me, true, 0.05, 0.05);
    }

    this.renderWorld();
  }

  // hex "#rrggbb" -> int 0xRRGGBB
  hexToInt(hex) {
    if (!hex || typeof hex !== "string") return 0xffffff;
    if (hex[0] === "#") hex = hex.slice(1);
    const val = parseInt(hex, 16);
    if (Number.isNaN(val)) return 0xffffff;
    return val;
  }

  renderWorld() {
    this.pelletGraphics.clear();
    this.playerGraphics.clear();

    // Nettoyage anciens textes
    if (this.nameTexts) {
      for (const txt of Object.values(this.nameTexts)) {
        txt.destroy();
      }
    }
    this.nameTexts = {};

    // Points
    this.pelletGraphics.fillStyle(0xffffff, 1);
    (state.pellets || []).forEach((p) => {
      this.pelletGraphics.fillCircle(p.x, p.y, 4);
    });

    // Araignées + pseudos
    for (const [id, p] of Object.entries(state.players || {})) {
      const colorInt = this.hexToInt(p.color);

      this.playerGraphics.lineStyle(3, 0x000000, 0.9);
      this.playerGraphics.fillStyle(colorInt, id === myId ? 1 : 0.8);

      this.playerGraphics.fillCircle(p.x, p.y, p.radius);
      this.playerGraphics.strokeCircle(p.x, p.y, p.radius);

      const legLength = p.radius * 1.4;
      for (let i = 0; i < 8; i++) {
        const angle = (Math.PI * 2 * i) / 8;
        const x1 = p.x + Math.cos(angle) * (p.radius * 0.7);
        const y1 = p.y + Math.sin(angle) * (p.radius * 0.7);
        const x2 = p.x + Math.cos(angle) * legLength;
        const y2 = p.y + Math.sin(angle) * legLength;
        this.playerGraphics.lineBetween(x1, y1, x2, y2);
      }

      const displayName = p.name || `Joueur ${id.slice(0, 4)}`;
      const fontSize = Math.max(12, p.radius * 0.4);

      const label = this.add
        .text(p.x, p.y - p.radius - 6, displayName, {
          fontSize: `${fontSize}px`,
          color: "#ffffff",
          stroke: "#000000",
          strokeThickness: 3
        })
        .setOrigin(0.5, 1);

      this.nameTexts[id] = label;
    }
  }
}

// Config Phaser
const config = {
  type: Phaser.AUTO,
  parent: "game-container",
  width: window.innerWidth,
  height: window.innerHeight,
  backgroundColor: "#111111",
  physics: { default: "arcade" },
  scene: [SpiderScene]
};

new Phaser.Game(config);
console.log("🚀 Phaser Game lancé");
