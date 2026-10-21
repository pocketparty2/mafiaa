import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  collection,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  appId: "YOUR_APP_ID"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "europe-west1");

const call = (name, data) =>
  httpsCallable(functions, name)(data).then(result => result.data);

const $ = id => document.getElementById(id);

const screens = {
  auth: $("auth-screen"),
  home: $("home-screen"),
  game: $("game-screen")
};

let currentUser = null;
let roomCode = null;
let roomData = null;
let players = [];
let myState = null;
let stopRoomListener = null;
let stopPlayersListener = null;
let timerHandle = null;
let pollHandle = null;
let lastStateKey = "";
let busy = false;

function showScreen(name) {
  Object.entries(screens).forEach(([key, element]) => {
    element.classList.toggle("hidden", key !== name);
  });
}

function notify(message, type = "") {
  const box = $("notice");
  box.textContent = message;
  box.className = `notice ${type}`.trim();
  box.classList.remove("hidden");
}

function clearNotice() {
  $("notice").classList.add("hidden");
}

function friendlyError(error) {
  const messages = {
    "auth/email-already-in-use": "That email already has an account.",
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/weak-password": "Choose a stronger password.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
    "functions/unauthenticated": "Please sign in again.",
    "functions/permission-denied": "You aren't allowed to do that.",
    "functions/not-found": "That room could not be found.",
    "functions/failed-precondition": "That action isn't available right now.",
    "functions/resource-exhausted": "The room is full or temporarily unavailable."
  };

  return messages[error.code] ||
    error.message ||
    "Something went wrong. Please try again.";
}

async function runAction(task, successMessage) {
  if (busy) return;
  busy = true;
  clearNotice();

  try {
    await task();
    if (successMessage) notify(successMessage, "success");
  } catch (error) {
    console.error(error);
    notify(friendlyError(error), "error");
  } finally {
    busy = false;
  }
}

function stopListening() {
  stopRoomListener?.();
  stopPlayersListener?.();
  stopRoomListener = null;
  stopPlayersListener = null;

  if (timerHandle) clearInterval(timerHandle);
  if (pollHandle) clearInterval(pollHandle);

  timerHandle = null;
  pollHandle = null;
}

function resetRoomView() {
  stopListening();
  roomCode = null;
  roomData = null;
  players = [];
  myState = null;
  lastStateKey = "";
}

$("auth-form").addEventListener("submit", event => {
  event.preventDefault();

  runAction(async () => {
    await signInWithEmailAndPassword(
      auth,
      $("email").value.trim(),
      $("password").value
    );
  });
});

$("signup").addEventListener("click", () => {
  runAction(async () => {
    await createUserWithEmailAndPassword(
      auth,
      $("email").value.trim(),
      $("password").value
    );
    notify("Account created. Welcome!", "success");
  });
});

$("signout").addEventListener("click", () => {
  runAction(() => signOut(auth));
});

$("create-form").addEventListener("submit", event => {
  event.preventDefault();

  runAction(async () => {
    const result = await call("createRoom", {
      name: $("player-name").value,
      revealRoles: $("reveal-check").checked
    });

    connectToRoom(result.code);
  });
});

$("join-form").addEventListener("submit", event => {
  event.preventDefault();

  runAction(async () => {
    const code = $("room-code").value.trim().toUpperCase();

    await call("joinRoom", {
      code,
      name: $("player-name").value
    });

    connectToRoom(code);
  });
});

$("room-code").addEventListener("input", event => {
  event.target.value = event.target.value
    .replace(/[^a-z]/gi, "")
    .toUpperCase()
    .slice(0, 4);
});

$("copy-code").addEventListener("click", () => {
  runAction(async () => {
    await navigator.clipboard.writeText(roomCode);
  }, "Room code copied!");
});

$("ready-check").addEventListener("change", event => {
  if (!roomCode) return;

  runAction(() => call("setReady", {
    code: roomCode,
    ready: event.target.checked
  }));
});

$("reveal-check").addEventListener("change", event => {
  if (!roomCode) return;

  runAction(() => call("setSettings", {
    code: roomCode,
    revealRoles: event.target.checked
  }));
});

$("start-game").addEventListener("click", () => {
  runAction(() => call("startGame", { code: roomCode }));
});

$("night-buttons").addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const targetUid = $("target-select").value;
  if (!targetUid) {
    notify("Choose a living player first.", "error");
    return;
  }

  runAction(async () => {
    await call("submitNightAction", {
      code: roomCode,
      action: button.dataset.action,
      targetUid
    });

    $("action-status").textContent = "Night action submitted.";
  });
});

$("submit-vote").addEventListener("click", () => {
  const targetUid = $("target-select").value;

  if (!targetUid) {
    notify("Choose a living player first.", "error");
    return;
  }

  runAction(async () => {
    await call("submitVote", { code: roomCode, targetUid });
    $("action-status").textContent = "Vote submitted.";
  });
});

$("leave-room").addEventListener("click", () => {
  if (!roomCode) return;

  runAction(async () => {
    await call("leaveRoom", { code: roomCode });
    resetRoomView();
    showScreen("home");
    clearNotice();
  });
});

function connectToRoom(code) {
  resetRoomView();
  roomCode = code;
  $("room-code-display").textContent = code;
  showScreen("game");

  stopRoomListener = onSnapshot(
    doc(db, "rooms", code),
    async snapshot => {
      if (!snapshot.exists()) {
        resetRoomView();
        showScreen("home");
        notify("This room no longer exists.", "error");
        return;
      }

      roomData = snapshot.data();
      $("reveal-check").checked =
        roomData.settings?.revealRoles !== false;

      renderRoom();

      try {
        myState = await call("getMyState", { code });
        renderRoom();
      } catch (error) {
        console.error("Couldn't refresh private state:", error);
      }
    },
    error => notify(friendlyError(error), "error")
  );

  stopPlayersListener = onSnapshot(
    collection(db, "rooms", code, "players"),
    snapshot => {
      players = snapshot.docs.map(d => ({ uid: d.id, ...d.data() }));
      renderRoom();
    },
    error => notify(friendlyError(error), "error")
  );

  // The server decides whether a phase is actually overdue.
  // This client timer only requests a server-side check.
  pollHandle = setInterval(() => {
    if (!roomCode || document.hidden) return;

    call("advanceIfDue", { code: roomCode }).catch(error => {
      console.error("Phase check failed:", error);
    });
  }, 3000);

  timerHandle = setInterval(renderTimer, 250);
}

function phaseDetails(phase) {
  return {
    lobby: ["Waiting in lobby", "Get everyone ready before the host starts."],
    night: ["Nightfall", "Special roles, choose your actions in secret."],
    discussion: ["Morning discussion", "Talk through the clues and decide who seems suspicious."],
    voting: ["Voting time", "Choose one living player to eliminate."],
    finished: ["Game over", "The winner has been decided."]
  }[phase] || ["Unknown phase", ""];
}

function renderRoom() {
  if (!roomData) return;

  const [title, description] = phaseDetails(roomData.phase);
  $("phase-title").textContent = title;
  $("phase-description").textContent = description;
  $("round-label").textContent = roomData.phase === "lobby"
    ? "Waiting for game to start"
    : `Round ${roomData.round || 1}`;

  $("player-count").textContent = `${players.length}/12`;

  const isHost = currentUser?.uid === roomData.hostUid;
  const isLobby = roomData.phase === "lobby";
  const isAlive = myState?.alive === true;

  $("lobby-controls").classList.toggle("hidden", !isLobby);
  $("ready-check").disabled = isHost;
  $("ready-check").checked =
    players.find(p => p.uid === currentUser?.uid)?.ready === true;

  $("reveal-setting").classList.toggle("hidden", !isLobby || !isHost);
  $("start-game").classList.toggle("hidden", !isLobby || !isHost);
  $("start-game").disabled =
    players.length < 5 || players.length > 12 ||
    players.some(p => !p.ready);

  $("action-controls").classList.toggle(
    "hidden",
    isLobby || roomData.phase === "finished" || !isAlive
  );
  $("finished-card").classList.toggle("hidden", roomData.phase !== "finished");
  $("role-card").classList.toggle("hidden", !myState?.role);
  $("leave-room").classList.toggle("hidden", roomData.phase === "finished");

  $("winner-text").textContent = roomData.winner === "Town"
    ? "The Town wins!"
    : roomData.winner === "Mafia"
      ? "The Mafia wins!"
      : "Game ended.";

  if (myState?.role) {
    $("role-name").textContent = myState.role;
    $("role-description").textContent = ({
      Mafia: "At night, choose a player to eliminate. Work with your fellow Mafia.",
      Townsperson: "You have no night action. Use discussion and voting to find the Mafia.",
      Detective: "Investigate one player each night to discover whether they are Mafia.",
      Doctor: "Protect one player each night from the Mafia's attack."
    })[myState.role] || "";

    $("team-info").textContent = myState.role === "Mafia"
      ? "Your fellow Mafia: " +
        (myState.mafiaTeammates?.map(p => p.name).join(", ") || "None")
      : "";

    const investigation = myState.investigation;
    $("investigation-result").textContent = investigation
      ? `Round ${investigation.round}: ${investigation.targetName} ${
          investigation.isMafia ? "is Mafia." : "is not Mafia."
        }`
      : "";
  }

  const canNightAct = roomData.phase === "night" && isAlive;
  const role = myState?.role;

  $("night-buttons").classList.toggle("hidden", !canNightAct);
  $("submit-vote").classList.toggle(
    "hidden",
    roomData.phase !== "voting" || !isAlive
  );

  $("night-buttons").querySelectorAll("button").forEach(button => {
    button.classList.toggle("hidden", !({
      Mafia: "kill",
      Detective: "investigate",
      Doctor: "protect"
    })[role] || button.dataset.action !== ({
      Mafia: "kill",
      Detective: "investigate",
      Doctor: "protect"
    })[role]);
  });

  renderPlayers();
  renderTargets();
  renderTimer();
}

function renderPlayers() {
  const list = $("player-list");
  list.replaceChildren();

  for (const player of players) {
    const row = document.createElement("div");
    row.className = "player" + (player.alive ? "" : " dead");

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = (player.name || "?").slice(0, 1).toUpperCase();

    const meta = document.createElement("div");
    meta.className = "player-meta";

    const name = document.createElement("div");
    name.className = "player-name";
    name.textContent = player.name || "Player";

    if (player.uid === roomData.hostUid) {
      name.textContent += " ★";
    }

    const status = document.createElement("div");
    status.className = "player-status";
    status.textContent = !player.alive
      ? "Eliminated"
      : roomData.phase === "lobby"
        ? (player.ready ? "Ready" : "Not ready")
        : "In the game";

    meta.append(name, status);

    const tag = document.createElement("span");
    tag.className = "tag" + (!player.alive ? " dead" : player.ready ? " ready" : "");
    tag.textContent = !player.alive
      ? (player.roleReveal || "Dead")
      : roomData.phase === "lobby"
        ? (player.ready ? "READY" : "WAITING")
        : "ALIVE";

    row.append(avatar, meta, tag);
    list.append(row);
  }
}

function renderTargets() {
  const select = $("target-select");
  const previous = select.value;
  select.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a player...";
  select.append(placeholder);

  for (const player of players) {
    if (!player.alive || player.uid === currentUser?.uid) continue;

    const option = document.createElement("option");
    option.value = player.uid;
    option.textContent = player.name;
    select.append(option);
  }

  if ([...select.options].some(option => option.value === previous)) {
    select.value = previous;
  }
}

function renderTimer() {
  if (!roomData?.endsAt || roomData.phase === "lobby" ||
      roomData.phase === "finished") {
    $("timer").textContent = "--:--";
    return;
  }

  const seconds = Math.max(
    0,
    Math.ceil((roomData.endsAt - Date.now()) / 1000)
  );

  $("timer").textContent =
    `${String(Math.floor(seconds / 60)).padStart(2, "0")}:` +
    `${String(seconds % 60).padStart(2, "0")}`;
}

onAuthStateChanged(auth, user => {
  currentUser = user;
  $("signout").classList.toggle("hidden", !user);

  if (!user) {
    resetRoomView();
    showScreen("auth");
  } else if (!roomCode) {
    showScreen("home");
  }
});
