
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  updateEmail,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  collection,
  onSnapshot,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  runTransaction,
  serverTimestamp,
  arrayUnion
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD0ZjBJ243WhZHxsDldwAMjEIB3Cb9jBKo",
  authDomain: "mafia-f53f0.firebaseapp.com",
  projectId: "mafia-f53f0",
  storageBucket: "mafia-f53f0.firebasestorage.app",
  messagingSenderId: "148659345455",
  appId: "1:148659345455:web:044ea140e1ee3678910eda",
  measurementId: "G-MMEZ6XBC76"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = id => document.getElementById(id);

const GAME_LENGTH = 12;
const NIGHT_SECONDS = 35;
const DISCUSSION_SECONDS = 25;
const VOTING_SECONDS = 35;
const MAX_PLAYERS = 12;
const MIN_PLAYERS = 5;

let currentUser = null;
let profile = { displayName: "", avatarData: "" };
let pendingSignupAvatar = "";
let pendingEditAvatar = null;
let signupMode = false;

let roomCode = null;
let room = null;
let players = [];
let privateByUid = {};
let actionsByUid = {};
let myAction = null;
let activeLobbyTab = "settings";

let unsubRoom = null;
let unsubPlayers = null;
let unsubPrivate = null;
let unsubActions = null;
let unsubMyPrivate = null;
let unsubMyAction = null;
let hostListenersCode = null;

let timerHandle = null;
let resolving = false;
let leavingRoom = false;
let lastHostHeartbeatAt = 0;
let claimingHost = false;

/* -------------------- GENERAL UTILITIES -------------------- */

function showNotice(message, isError = false) {
  const el = $("notice");
  if (!el) return;

  el.textContent = message;
  el.classList.remove("hidden");
  el.classList.toggle("error", isError);

  window.clearTimeout(showNotice.timeout);
  showNotice.timeout = window.setTimeout(() => {
    el.classList.add("hidden");
  }, 5000);
}

function friendlyError(error) {
  const messages = {
    "auth/email-already-in-use": "That email already has an account. Try signing in.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/invalid-credential": "That email and password combination wasn't accepted.",
    "auth/weak-password": "Choose a password with at least 6 characters.",
    "auth/requires-recent-login": "Sign in again before changing those account details.",
    "auth/too-many-requests": "Too many attempts. Wait a little and try again.",
    "permission-denied": "Firebase blocked that action. Check that your Firestore rules have been published.",
    "unavailable": "Firebase is temporarily unavailable. Try again shortly."
  };

  const code = error?.code || "";
  const key = code.startsWith("firestore/")
    ? code.slice("firestore/".length)
    : code;

  return messages[key] || error?.message || "Something went wrong.";
}

function setVisible(id, visible) {
  $(id)?.classList.toggle("hidden", !visible);
}

function showScreen(screen) {
  setVisible("auth-screen", screen === "auth");
  setVisible("home-screen", screen === "home");
  setVisible("game-screen", screen === "game");
  setVisible("signout", Boolean(currentUser));
}

function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 18);
}

function getDisplayName() {
  return cleanName(profile.displayName) ||
    cleanName(currentUser?.email?.split("@")[0]) ||
    "Player";
}

function roomRef(code = roomCode) {
  return doc(db, "rooms", code);
}

function playersRef(code = roomCode) {
  return collection(db, "rooms", code, "players");
}

function playerRef(uid, code = roomCode) {
  return doc(db, "rooms", code, "players", uid);
}

function privateRef(uid, code = roomCode) {
  return doc(db, "rooms", code, "private", uid);
}

function actionsRef(code = roomCode) {
  return collection(db, "rooms", code, "actions");
}

function actionRef(uid, code = roomCode) {
  return doc(db, "rooms", code, "actions", uid);
}

function isHost() {
  return Boolean(currentUser && room?.hostUid === currentUser.uid);
}

function me() {
  return players.find(player => player.id === currentUser?.uid) || null;
}

function myRole() {
  return privateByUid[currentUser?.uid]?.role || null;
}

function alivePlayers() {
  return players.filter(player => player.alive !== false);
}

function playerName(uid) {
  return players.find(player => player.id === uid)?.name || "Unknown player";
}

function shuffle(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function randomRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from(
    { length: 4 },
    () => alphabet[Math.floor(Math.random() * alphabet.length)]
  ).join("");
}

function secondsUntil(timestamp) {
  if (!timestamp) return 0;

  const milliseconds = typeof timestamp.toMillis === "function"
    ? timestamp.toMillis()
    : Number(timestamp);

  return Math.max(0, Math.ceil((milliseconds - Date.now()) / 1000));
}

function timestampAfter(seconds) {
  return new Date(Date.now() + seconds * 1000);
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

/* -------------------- PROFILE IMAGES -------------------- */

async function resizeImage(file) {
  if (!file) return "";

  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose an image file.");
  }

  if (file.size > 8 * 1024 * 1024) {
    throw new Error("Please choose an image smaller than 8 MB.");
  }

  const bitmap = await createImageBitmap(file);
  const maxDimension = 240;
  const scale = Math.min(
    1,
    maxDimension / Math.max(bitmap.width, bitmap.height)
  );

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));

  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  let quality = 0.82;
  let data = canvas.toDataURL("image/jpeg", quality);

  while (data.length > 140000 && quality > 0.35) {
    quality -= 0.1;
    data = canvas.toDataURL("image/jpeg", quality);
  }

  if (data.length > 150000) {
    throw new Error("That image is too large even after resizing. Try another image.");
  }

  return data;
}

function renderAvatar(element, data, name = "") {
  if (!element) return;

  element.replaceChildren();

  if (data) {
    const image = document.createElement("img");
    image.src = data;
    image.alt = name ? `${name}'s profile picture` : "Profile picture";
    image.className = "avatar-image";
    element.append(image);
  } else {
    element.textContent = (name.trim()[0] || "?").toUpperCase();
  }
}

function renderProfile() {
  const name = getDisplayName();

  if ($("profile-display-name")) {
    $("profile-display-name").textContent = name;
  }

  if ($("profile-email")) {
    $("profile-email").textContent = currentUser?.email || "";
  }

  renderAvatar($("profile-avatar"), profile.avatarData, name);

  if ($("edit-display-name")) {
    $("edit-display-name").value = name;
  }

  if ($("edit-email")) {
    $("edit-email").value = currentUser?.email || "";
  }

  if ($("edit-avatar-preview")) {
    renderAvatar(
      $("edit-avatar-preview"),
      pendingEditAvatar ?? profile.avatarData,
      name
    );
  }

  if ($("signup-avatar-preview")) {
    renderAvatar($("signup-avatar-preview"), pendingSignupAvatar, name);
  }
}

async function saveProfileDocument(displayName, avatarData) {
  await setDoc(doc(db, "users", currentUser.uid), {
    displayName: cleanName(displayName),
    avatarData: avatarData || "",
    updatedAt: serverTimestamp()
  });
}

async function loadProfile() {
  const snapshot = await getDoc(doc(db, "users", currentUser.uid));

  if (snapshot.exists()) {
    const data = snapshot.data();
    profile = {
      displayName: cleanName(data.displayName),
      avatarData: data.avatarData || ""
    };
  } else {
    profile = {
      displayName: cleanName(currentUser.email?.split("@")[0]) || "Player",
      avatarData: ""
    };
  }

  renderProfile();
}

/* -------------------- AUTHENTICATION -------------------- */

$("signup").addEventListener("click", () => {
  signupMode = !signupMode;

  setVisible("signup-fields", signupMode);
  $("signup").textContent = signupMode ? "Back to sign in" : "Create account";
  $("signin").textContent = signupMode ? "Create account" : "Sign in";

  $("signup-name").required = signupMode;
  $("password").autocomplete = signupMode ? "new-password" : "current-password";
});

$("signup-avatar").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    pendingSignupAvatar = await resizeImage(file);
    renderAvatar(
      $("signup-avatar-preview"),
      pendingSignupAvatar,
      $("signup-name").value
    );
  } catch (error) {
    showNotice(friendlyError(error), true);
    event.target.value = "";
  }
});

$("auth-form").addEventListener("submit", async event => {
  event.preventDefault();

  const email = $("email").value.trim();
  const password = $("password").value;

  $("signin").disabled = true;
  $("signup").disabled = true;

  try {
    if (signupMode) {
      const displayName = cleanName($("signup-name").value);

      if (displayName.length < 2) {
        throw new Error("Your display name must have at least 2 characters.");
      }

      const credential = await createUserWithEmailAndPassword(auth, email, password);
      currentUser = credential.user;

      profile = {
        displayName,
        avatarData: pendingSignupAvatar || ""
      };

      await saveProfileDocument(profile.displayName, profile.avatarData);

      pendingSignupAvatar = "";
      $("signup-avatar").value = "";
      $("signup-name").value = "";
      $("password").value = "";

      signupMode = false;
      setVisible("signup-fields", false);
      $("signup").textContent = "Create account";
      $("signin").textContent = "Sign in";

      showNotice("Account created. Your profile is ready!");
      showScreen("home");
      renderProfile();
    } else {
      await signInWithEmailAndPassword(auth, email, password);
      $("password").value = "";
    }
  } catch (error) {
    showNotice(friendlyError(error), true);
  } finally {
    $("signin").disabled = false;
    $("signup").disabled = false;
  }
});

onAuthStateChanged(auth, async user => {
  currentUser = user;

  if (!user) {
    disconnectRoomListeners();
    roomCode = null;
    room = null;
    players = [];
    privateByUid = {};
    actionsByUid = {};
    myAction = null;
    profile = { displayName: "", avatarData: "" };
    showScreen("auth");
    return;
  }

  try {
    await loadProfile();
    showScreen(roomCode ? "game" : "home");
  } catch (error) {
    showNotice(`Couldn't load your profile: ${friendlyError(error)}`, true);
    showScreen("home");
  }
});

$("signout").addEventListener("click", async () => {
  try {
    if (roomCode) {
      await leaveCurrentRoom(false);
    }

    await signOut(auth);
  } catch (error) {
    showNotice(friendlyError(error), true);
  }
});

/* -------------------- PROFILE EDITOR -------------------- */

$("edit-profile-button").addEventListener("click", () => {
  pendingEditAvatar = null;
  $("edit-display-name").value = getDisplayName();
  $("edit-email").value = currentUser.email || "";
  $("current-password").value = "";
  $("new-password").value = "";
  $("edit-avatar").value = "";

  setVisible("password-fields", false);

  renderAvatar(
    $("edit-avatar-preview"),
    profile.avatarData,
    getDisplayName()
  );

  setVisible("profile-editor", true);
});

$("change-password-button").addEventListener("click", () => {
  const fields = $("password-fields");
  if (!fields) return;

  const opening = fields.classList.contains("hidden");
  setVisible("password-fields", opening);

  if (!opening) {
    $("current-password").value = "";
    $("new-password").value = "";
  }
});

$("cancel-profile").addEventListener("click", () => {
  pendingEditAvatar = null;
  setVisible("profile-editor", false);
  setVisible("password-fields", false);
  renderProfile();
});

$("edit-avatar").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    pendingEditAvatar = await resizeImage(file);
    renderAvatar(
      $("edit-avatar-preview"),
      pendingEditAvatar,
      $("edit-display-name").value
    );
  } catch (error) {
    showNotice(friendlyError(error), true);
    event.target.value = "";
  }
});

$("remove-avatar").addEventListener("click", () => {
  pendingEditAvatar = "";
  renderAvatar(
    $("edit-avatar-preview"),
    "",
    $("edit-display-name").value
  );
});

$("save-profile").addEventListener("click", async () => {
  const displayName = cleanName($("edit-display-name").value);
  const email = $("edit-email").value.trim();
  const currentPassword = $("current-password").value;
  const newPassword = $("new-password").value;
  const avatarData = pendingEditAvatar === null
    ? profile.avatarData
    : pendingEditAvatar;

  if (displayName.length < 2) {
    showNotice("Your display name must have at least 2 characters.", true);
    return;
  }

  if (!email) {
    showNotice("Enter a valid email address.", true);
    return;
  }

  const emailChanged = email !== currentUser.email;
  const passwordChanged = Boolean(newPassword);

  try {
    $("save-profile").disabled = true;

    if (emailChanged || passwordChanged) {
      if (!currentPassword) {
        throw new Error("Enter your current password to change your email or password.");
      }

      const credential = EmailAuthProvider.credential(
        currentUser.email,
        currentPassword
      );

      await reauthenticateWithCredential(currentUser, credential);
    }

    if (emailChanged) {
      await updateEmail(currentUser, email);
    }

    if (passwordChanged) {
      if (newPassword.length < 6) {
        throw new Error("Your new password must have at least 6 characters.");
      }

      await updatePassword(currentUser, newPassword);
    }

    await saveProfileDocument(displayName, avatarData);

    profile = { displayName, avatarData };
    pendingEditAvatar = null;

    $("current-password").value = "";
    $("new-password").value = "";

    renderProfile();
    setVisible("profile-editor", false);
    setVisible("password-fields", false);
    showNotice("Profile updated!");
  } catch (error) {
    showNotice(friendlyError(error), true);
  } finally {
    $("save-profile").disabled = false;
  }
});

/* -------------------- ROOM CREATION AND JOINING -------------------- */

$("create-form").addEventListener("submit", async event => {
  event.preventDefault();

  if (!currentUser) return;

  const name = getDisplayName();

  try {
    const button = $("create-form").querySelector('button[type="submit"]');
    button.disabled = true;

    let createdCode = null;

    for (let attempt = 0; attempt < 8; attempt++) {
      const code = randomRoomCode();
      const ref = roomRef(code);

      try {
        await runTransaction(db, async transaction => {
          const existing = await transaction.get(ref);

          if (existing.exists()) {
            throw new Error("CODE_TAKEN");
          }

          transaction.set(ref, {
            code,
            hostUid: currentUser.uid,
            memberUids: [currentUser.uid],
            phase: "lobby",
            round: 0,
            settings: { revealRoles: true, roleCounts: { Mafia: 1, Detective: 0, Doctor: 0, Townsperson: 0 } },
            winner: null,
            endsAt: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        });

        createdCode = code;
        break;
      } catch (error) {
        if (error.message !== "CODE_TAKEN") throw error;
      }
    }

    if (!createdCode) {
      throw new Error("Couldn't generate a room code. Please try again.");
    }

    await setDoc(playerRef(currentUser.uid, createdCode), {
      uid: currentUser.uid,
      name,
      avatarData: profile.avatarData || "",
      ready: false,
      alive: true,
      roleReveal: null,
      joinedAt: serverTimestamp()
    });

    connectToRoom(createdCode);
    showNotice(`Room ${createdCode} created! Share the code with your friends.`);
  } catch (error) {
    showNotice(`Couldn't create room: ${friendlyError(error)}`, true);
  } finally {
    const button = $("create-form").querySelector('button[type="submit"]');
    button.disabled = false;
  }
});

$("join-form").addEventListener("submit", async event => {
  event.preventDefault();

  if (!currentUser) {
    showNotice("Please sign in before joining a room.", true);
    return;
  }

  const code = $("room-code").value.trim().toUpperCase();

  if (!/^[A-HJ-NP-Z]{4}$/.test(code)) {
    showNotice("Enter a valid four-letter room code.", true);
    return;
  }

  const button = $("join-form").querySelector('button[type="submit"]');

  try {
    button.disabled = true;

    const ref = roomRef(code);
    const snapshot = await getDoc(ref);

    if (!snapshot.exists()) {
      throw new Error("No room exists with that code.");
    }

    const data = snapshot.data();
    const members = data.memberUids || [];
    const alreadyMember = members.includes(currentUser.uid);

    if (data.phase !== "lobby" && !alreadyMember) {
      throw new Error("That game has already started.");
    }

    if (!alreadyMember && members.length >= MAX_PLAYERS) {
      throw new Error("That room is full.");
    }

    if (!alreadyMember) {
      await updateDoc(ref, {
        memberUids: arrayUnion(currentUser.uid),
        updatedAt: serverTimestamp()
      });
    }

    await setDoc(playerRef(currentUser.uid, code), {
      uid: currentUser.uid,
      name: getDisplayName(),
      avatarData: profile.avatarData || "",
      ready: false,
      alive: true,
      roleReveal: null,
      joinedAt: serverTimestamp()
    });

    connectToRoom(code);
    showNotice(`Joined room ${code}!`);
  } catch (error) {
    console.error("Join room failed:", error);
    showNotice(`Couldn't join room: ${friendlyError(error)}`, true);
  } finally {
    button.disabled = false;
  }
});

/* -------------------- ROOM LISTENERS -------------------- */

function disconnectRoomListeners() {
  unsubRoom?.();
  unsubPlayers?.();
  unsubPrivate?.();
  unsubActions?.();
  unsubMyPrivate?.();
  unsubMyAction?.();

  unsubRoom = null;
  unsubPlayers = null;
  unsubPrivate = null;
  unsubActions = null;
  unsubMyPrivate = null;
  unsubMyAction = null;
  hostListenersCode = null;

  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }

  lastHostHeartbeatAt = 0;
  claimingHost = false;
}

function connectToRoom(code) {
  disconnectRoomListeners();

  roomCode = code;
  room = null;
  players = [];
  privateByUid = {};
  actionsByUid = {};
  myAction = null;
  resolving = false;
  leavingRoom = false;
  lastHostHeartbeatAt = 0;
  claimingHost = false;
  activeLobbyTab = "settings";

  $("room-code-display").textContent = code;
  $("room-code").value = "";

  showScreen("game");

  unsubRoom = onSnapshot(roomRef(code), snapshot => {
    if (!snapshot.exists()) {
      showNotice("This room no longer exists.", true);
      disconnectRoomListeners();
      roomCode = null;
      room = null;
      players = [];
      showScreen("home");
      return;
    }

    room = snapshot.data();

    if (!currentUser || !(room.memberUids || []).includes(currentUser.uid)) {
      showNotice("You've left this room.");
      disconnectRoomListeners();
      roomCode = null;
      room = null;
      players = [];
      showScreen("home");
      return;
    }

    // Attach host-only listeners after the room document has loaded.
    if (isHost() && hostListenersCode !== code) {
      attachHostListeners(code);
      hostListenersCode = code;
    } else if (!isHost() && hostListenersCode === code) {
      unsubPrivate?.();
      unsubActions?.();
      unsubPrivate = null;
      unsubActions = null;
      hostListenersCode = null;
      privateByUid = {};
      actionsByUid = {};
    }

    renderGame();
    maintainHostLease();
    maybeResolvePhase();
  }, error => {
    showNotice(`Room listener failed: ${friendlyError(error)}`, true);
  });

  unsubPlayers = onSnapshot(playersRef(code), snapshot => {
    players = snapshot.docs.map(item => ({
      id: item.id,
      ...item.data()
    }));

    players.sort((a, b) => {
      if (a.id === room?.hostUid) return -1;
      if (b.id === room?.hostUid) return 1;
      return (a.name || "").localeCompare(b.name || "");
    });

    renderGame();
    maybeResolvePhase();
  }, error => {
    showNotice(`Player list failed: ${friendlyError(error)}`, true);
  });

  if (currentUser) {
    unsubMyPrivate = onSnapshot(privateRef(currentUser.uid, code), snapshot => {
      // Hosts receive the full collection through attachHostListeners.
      if (!isHost()) {
        if (snapshot.exists()) {
          privateByUid[currentUser.uid] = snapshot.data();
        } else {
          delete privateByUid[currentUser.uid];
        }

        renderGame();
      }
    }, error => {
      showNotice(`Couldn't load your role: ${friendlyError(error)}`, true);
    });

    unsubMyAction = onSnapshot(actionRef(currentUser.uid, code), snapshot => {
      myAction = snapshot.exists() ? snapshot.data() : null;
      renderGame();
    }, error => {
      showNotice(`Couldn't load your action: ${friendlyError(error)}`, true);
    });
  }

  if (timerHandle) clearInterval(timerHandle);

  timerHandle = setInterval(() => {
    renderTimer();
    maintainHostLease();
    maybeResolvePhase();
  }, 1000);
}

async function maintainHostLease() {
  if (!room || !currentUser || !roomCode || room.phase === "finished") return;

  if (isHost()) {
    if (Date.now() - lastHostHeartbeatAt < 10000) return;

    lastHostHeartbeatAt = Date.now();
    updateDoc(roomRef(), {
      hostHeartbeatAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }).catch(error => {
      console.warn("Host heartbeat failed:", error);
    });
    return;
  }

  if (claimingHost) return;

  const heartbeat = room.hostHeartbeatAt || room.createdAt;
  const heartbeatMs = typeof heartbeat?.toMillis === "function"
    ? heartbeat.toMillis()
    : Number(heartbeat || 0);

  if (!heartbeatMs || Date.now() - heartbeatMs < 30000) return;

  claimingHost = true;

  try {
    await updateDoc(roomRef(), {
      hostUid: currentUser.uid,
      hostHeartbeatAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    showNotice("The host was inactive, so you've taken over the room.");
  } catch (error) {
    if (error?.code !== "permission-denied") {
      console.warn("Host handover failed:", error);
    }
  } finally {
    claimingHost = false;
  }
}

function attachHostListeners(code) {
  unsubPrivate?.();
  unsubActions?.();

  unsubPrivate = onSnapshot(collection(db, "rooms", code, "private"), snapshot => {
    privateByUid = {};

    snapshot.docs.forEach(item => {
      privateByUid[item.id] = item.data();
    });

    renderGame();
    maybeResolvePhase();
  }, error => {
    showNotice(`Host role listener failed: ${friendlyError(error)}`, true);
  });

  unsubActions = onSnapshot(actionsRef(code), snapshot => {
    actionsByUid = {};

    snapshot.docs.forEach(item => {
      actionsByUid[item.id] = item.data();
    });

    renderGame();
    maybeResolvePhase();
  }, error => {
    showNotice(`Host action listener failed: ${friendlyError(error)}`, true);
  });
}

/* -------------------- GAME AND LOBBY RENDERING -------------------- */

function renderGame() {
  if (!room || !currentUser) return;

  $("room-code-display").textContent = roomCode || "----";

  const phase = room.phase || "lobby";
  const host = isHost();
  const self = me();
  const role = myRole();
  const inLobby = phase === "lobby";

  // Lobby and active-game layouts are separate.
  setVisible("lobby-layout", inLobby);
  setVisible("game-grid", !inLobby);

  // Only the host gets tabs.
  setVisible("lobby-tabs", inLobby && host);

  // The host starts on Settings and can switch to Players.
  setVisible(
    "lobby-settings-panel",
    inLobby && host && activeLobbyTab === "settings"
  );

  // Non-hosts always see the player list.
  setVisible(
    "lobby-players-panel",
    inLobby && (!host || activeLobbyTab === "players")
  );

  document.querySelectorAll("[data-lobby-tab]").forEach(button => {
    const active = button.dataset.lobbyTab === activeLobbyTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });

  $("lobby-player-count").textContent = `${players.length}/${MAX_PLAYERS}`;
  $("player-count").textContent = `${players.length}/${MAX_PLAYERS}`;

  $("phase-dot").className = `phase-dot phase-${phase}`;

  const phaseTitles = {
    lobby: "Waiting in lobby",
    night: "Night has fallen",
    discussion: "Discussion",
    voting: "Time to vote",
    finished: "Game over"
  };

  const phaseDescriptions = {
    lobby: host
      ? "You're hosting. Wait for everyone to join and ready up."
      : "Wait for the host to start once everyone is ready.",
    night: "The town is asleep. Your role determines what you can do.",
    discussion: "Talk it out. Who seems suspicious?",
    voting: "Choose the player you think should be eliminated.",
    finished: "The game has ended. See who survived."
  };

  $("phase-title").textContent = phaseTitles[phase] || "Game in progress";
  $("phase-description").textContent = phaseDescriptions[phase] || "";
  $("round-label").textContent = phase === "lobby"
    ? "Lobby"
    : phase === "finished"
      ? `Final round: ${room.round || 1}`
      : `Round ${room.round || 1}`;

  setVisible("lobby-controls", inLobby);
  setVisible("action-controls", phase === "night" || phase === "voting");
  setVisible("finished-card", phase === "finished");
  setVisible("role-card", Boolean(role) && !inLobby);

  // Ready status is available to all lobby members.
  $("ready-check").checked = Boolean(self?.ready);
  $("ready-check").disabled = !inLobby;

  // Reveal settings and Start Game are host-only.
  setVisible("reveal-setting", inLobby && host);
  $("reveal-check").checked = room.settings?.revealRoles !== false;
  $("reveal-check").disabled = !host || !inLobby;

  const roleCounts = getRoleCounts();
  let selectedRoleTotal = 0;
  ["Mafia", "Detective", "Doctor"].forEach(role => {
    const count = roleCounts[role];
    const input = $("role-count-" + role.toLowerCase());
    input.value = String(count);
    input.disabled = !host || !inLobby;
    selectedRoleTotal += count;
  });
  $("role-count-townsperson").textContent = String(roleCounts.Townsperson);
  $("role-count-summary").textContent = roleCounts.Townsperson + " Townsperson" + (roleCounts.Townsperson === 1 ? "" : "s") + " will be assigned automatically.";
  const roleCountsValid = Object.entries(roleCounts).every(([role, count]) =>
    Number.isInteger(count) && count >= 0 && count <= MAX_PLAYERS
  ) && selectedRoleTotal <= players.length;

  setVisible("start-game", inLobby && host);
  $("start-game").disabled =
    !host ||
    players.length < MIN_PLAYERS ||
    players.length > MAX_PLAYERS ||
    !players.every(player => player.ready) ||
    !roleCountsValid;

  if (role) {
    const roleInfo = {
      Mafia: {
        description: "Each night, help eliminate a Town player without being discovered.",
        team: "You win when the Mafia equal or outnumber the Town."
      },
      Detective: {
        description: "Investigate one living player each night to learn whether they're Mafia.",
        team: "You win by helping the Town eliminate the Mafia."
      },
      Doctor: {
        description: "Protect one living player each night from the Mafia's attack.",
        team: "You win by helping the Town eliminate the Mafia."
      },
      Townsperson: {
        description: "You have no special night action. Use discussion and voting to find the Mafia.",
        team: "You win when all Mafia are eliminated."
      }
    };

    $("role-name").textContent = role;
    $("role-description").textContent = roleInfo[role]?.description || "";
    $("team-info").textContent = roleInfo[role]?.team || "";

    const investigation = privateByUid[currentUser.uid]?.investigationResult;
    $("investigation-result").textContent = investigation || "";

    if (
      role === "Mafia" &&
      privateByUid[currentUser.uid]?.mafiaTeammates?.length
    ) {
      const names = privateByUid[currentUser.uid].mafiaTeammates
        .map(uid => playerName(uid))
        .join(", ");

      $("team-info").textContent =
        `Your fellow Mafia: ${names}. You win when the Mafia equal or outnumber the Town.`;
    }
  } else {
    $("role-name").textContent = "Not assigned yet";
    $("role-description").textContent = "";
    $("investigation-result").textContent = "";
    $("team-info").textContent = "";
  }

  $("winner-text").textContent = room.winner === "Mafia"
    ? "The Mafia win."
    : room.winner === "Town"
      ? "The Town wins."
      : "Game over";

  renderPlayers();
  renderTargetOptions();
  renderActionControls();
  renderTimer();

  if (phase === "lobby") {
    $("action-status").textContent = "";
  }
}

function renderPlayers() {
  // The lobby and active game each have their own player-list container.
  const containers = [
    $("lobby-player-list"),
    $("player-list")
  ].filter(Boolean);

  containers.forEach(container => {
    container.replaceChildren();

    players.forEach(player => {
      const isYou = player.id === currentUser?.uid;
      const isReady = room?.phase === "lobby" && Boolean(player.ready);
      const isDead = player.alive === false;

      const card = document.createElement("div");
      card.className = "player-card";

      if (isYou) card.classList.add("is-you");
      if (isReady) card.classList.add("is-ready");
      if (isDead) card.classList.add("is-dead");

      const avatarWrap = document.createElement("div");
      avatarWrap.className = "player-card-avatar-wrap";

      const avatar = document.createElement("div");
      avatar.className = "profile-avatar player-card-avatar";

      renderAvatar(
        avatar,
        player.avatarData || "",
        player.name || "Player"
      );

      avatarWrap.append(avatar);

      if (isReady) {
        const check = document.createElement("span");
        check.className = "player-ready-check";
        check.textContent = "✓";
        check.setAttribute("aria-label", "Ready");
        check.title = "Ready";
        avatarWrap.append(check);
      }

      const name = document.createElement("strong");
      name.className = "player-card-name";
      name.textContent = `${player.name || "Player"}${isYou ? " (You)" : ""}`;

      card.append(avatarWrap, name);

      if (isDead) {
        const status = document.createElement("span");
        status.className = "player-card-status";
        status.textContent = "Eliminated";
        card.append(status);
      } else if (room?.phase === "lobby") {
        const status = document.createElement("span");
        status.className = "player-card-status";
        status.textContent = isReady ? "Ready" : "Not ready";
        card.append(status);
      }

      if (
        isDead &&
        room?.settings?.revealRoles !== false &&
        player.roleReveal
      ) {
        const badge = document.createElement("span");
        badge.className = "role-badge";
        badge.textContent = player.roleReveal;
        card.append(badge);
      }

      container.append(card);
    });
  });
}

function renderTargetOptions() {
  const select = $("target-select");
  if (!select) return;

  const previous = select.value;
  select.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a player...";
  select.append(placeholder);

  const role = myRole();
  const phase = room?.phase;
  const selfUid = currentUser?.uid;

  let candidates = alivePlayers();

  if (phase === "night") {
    if (role === "Mafia") {
      const teammates = privateByUid[selfUid]?.mafiaTeammates || [];

      candidates = candidates.filter(player =>
        player.id !== selfUid &&
        !teammates.includes(player.id)
      );
    } else if (role === "Detective" || role === "Doctor") {
      candidates = candidates.filter(player => player.id !== selfUid);
    } else {
      candidates = [];
    }
  } else if (phase === "voting") {
    candidates = candidates.filter(player => player.id !== selfUid);
  } else {
    candidates = [];
  }

  candidates.forEach(player => {
    const option = document.createElement("option");
    option.value = player.id;
    option.textContent = player.name || "Player";
    select.append(option);
  });

  if ([...select.options].some(option => option.value === previous)) {
    select.value = previous;
  }
}

function renderActionControls() {
  const phase = room?.phase;
  const role = myRole();
  const self = me();
  const alive = self?.alive !== false;

  const currentAction = myAction &&
    myAction.phase === phase &&
    myAction.round === room?.round
      ? myAction
      : null;

  const nightEligible = phase === "night" &&
    alive &&
    ["Mafia", "Doctor", "Detective"].includes(role);

  setVisible("night-buttons", nightEligible);
  setVisible("submit-vote", phase === "voting" && alive);

  $("night-buttons").querySelectorAll("button").forEach(button => {
    const actionType = button.dataset.action;

    const allowed = (
      (role === "Mafia" && actionType === "kill") ||
      (role === "Doctor" && actionType === "protect") ||
      (role === "Detective" && actionType === "investigate")
    );

    button.classList.toggle("hidden", !allowed);
    button.disabled = Boolean(currentAction) || !allowed;
  });

  $("submit-vote").disabled =
    Boolean(currentAction) || phase !== "voting" || !alive;

  $("target-select").disabled =
    (!nightEligible && phase !== "voting") || Boolean(currentAction);

  if (currentAction) {
    $("action-status").textContent = phase === "voting"
      ? "Your vote has been submitted."
      : "Your night action has been submitted.";
  } else if (!alive && phase !== "lobby" && phase !== "finished") {
    $("action-status").textContent =
      "You've been eliminated. You can watch, but you can't act.";
  } else if (phase === "night" && !nightEligible) {
    $("action-status").textContent = "Your role has no action tonight.";
  } else {
    $("action-status").textContent = "";
  }
}

function renderTimer() {
  if (!room || !["night", "discussion", "voting"].includes(room.phase)) {
    $("timer").textContent = "--:--";
    return;
  }

  $("timer").textContent = formatTime(secondsUntil(room.endsAt));
}

/* -------------------- LOBBY TABS AND ACTIONS -------------------- */

document.querySelectorAll("[data-lobby-tab]").forEach(button => {
  button.addEventListener("click", () => {
    if (!isHost() || room?.phase !== "lobby") return;

    const tab = button.dataset.lobbyTab;
    if (!["settings", "players"].includes(tab)) return;

    activeLobbyTab = tab;
    renderGame();
  });
});

$("room-code-copy").addEventListener("click", async () => {
  if (!roomCode) return;

  try {
    await navigator.clipboard.writeText(roomCode);
    showNotice(`Room code ${roomCode} copied!`);
  } catch {
    showNotice(`Your room code is ${roomCode}. Copy it manually.`);
  }
});

$("ready-check").addEventListener("change", async event => {
  if (!roomCode || room?.phase !== "lobby" || !currentUser) return;

  try {
    await updateDoc(playerRef(currentUser.uid), {
      ready: event.target.checked
    });
  } catch (error) {
    showNotice(friendlyError(error), true);
    event.target.checked = Boolean(me()?.ready);
  }
});

$("reveal-check").addEventListener("change", async event => {
  if (!isHost() || room?.phase !== "lobby") return;

  try {
    await updateDoc(roomRef(), {
      settings: {
        ...(room.settings || {}),
        revealRoles: event.target.checked
      },
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    showNotice(friendlyError(error), true);
    event.target.checked = room.settings?.revealRoles !== false;
  }
});

const ROLE_NAMES = ["Mafia", "Detective", "Doctor", "Townsperson"];

function getRoleCounts() {
  const saved = room?.settings?.roleCounts || {};
  const counts = {
    Mafia: Number.isInteger(saved.Mafia) ? saved.Mafia : 1,
    Detective: Number.isInteger(saved.Detective) ? saved.Detective : 0,
    Doctor: Number.isInteger(saved.Doctor) ? saved.Doctor : 0
  };
  counts.Townsperson = Math.max(0, players.length - Object.values(counts).reduce((sum, count) => sum + count, 0));
  return counts;
}

async function saveRoleCounts() {
  if (!isHost() || room?.phase !== "lobby") return;
  const roleCounts = {};
  for (const role of ["Mafia", "Detective", "Doctor"]) {
    const input = $("role-count-" + role.toLowerCase());
    const value = Number(input?.value);
    if (!Number.isInteger(value) || value < 0 || value > MAX_PLAYERS) {
      showNotice("Role counts must be whole numbers from 0 to 12.", true);
      renderGame();
      return;
    }
    roleCounts[role] = value;
  }
  try {
    await updateDoc(roomRef(), {
      settings: { ...(room.settings || {}), roleCounts },
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    showNotice(friendlyError(error), true);
    renderGame();
  }
}

ROLE_NAMES.forEach(role => {
  $("role-count-" + role.toLowerCase()).addEventListener("change", saveRoleCounts);
});

$("start-game").addEventListener("click", startGame);

async function startGame() {
  if (!isHost() || room?.phase !== "lobby") return;

  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    showNotice(`You need ${MIN_PLAYERS}–${MAX_PLAYERS} players to start.`, true);
    return;
  }

  if (!players.every(player => player.ready)) {
    showNotice("Everyone needs to be ready before the game starts.", true);
    return;
  }

  try {
    $("start-game").disabled = true;

    const roleCounts = getRoleCounts();
    const selectedRoleTotal = Object.values(roleCounts).reduce((total, count) => total + count, 0);
    if (Object.values(roleCounts).some(count => !Number.isInteger(count) || count < 0 || count > MAX_PLAYERS) || selectedRoleTotal > players.length) {
      throw new Error("The selected special roles cannot exceed the number of players.");
    }

    const rolePool = [];
    ROLE_NAMES.forEach(role => {
      for (let count = 0; count < roleCounts[role]; count++) rolePool.push(role);
    });
    const shuffledPlayers = shuffle(players);
    const shuffledRoles = shuffle(rolePool);
    const roleAssignments = new Map();
    shuffledPlayers.forEach((player, index) => roleAssignments.set(player.id, shuffledRoles[index]));

    const mafiaUids = [...roleAssignments.entries()]
      .filter(([, role]) => role === "Mafia")
      .map(([uid]) => uid);

    const writes = players.map(async player => {
      const role = roleAssignments.get(player.id);

      await setDoc(privateRef(player.id), {
        role,
        investigationResult: "",
        mafiaTeammates: role === "Mafia"
          ? mafiaUids.filter(uid => uid !== player.id)
          : []
      });

      await updateDoc(playerRef(player.id), {
        ready: false,
        alive: true,
        roleReveal: null
      });
    });

    await Promise.all(writes);

    await Promise.all(
      Object.keys(actionsByUid).map(uid => deleteDoc(actionRef(uid)))
    );

    await updateDoc(roomRef(), {
      phase: "night",
      round: 1,
      winner: null,
      endsAt: timestampAfter(NIGHT_SECONDS),
      hostHeartbeatAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    showNotice("The game has started. Your role is secret!");
  } catch (error) {
    showNotice(`Couldn't start the game: ${friendlyError(error)}`, true);
  } finally {
    $("start-game").disabled = false;
  }
}

/* -------------------- NIGHT ACTIONS AND VOTING -------------------- */

$("night-buttons").addEventListener("click", async event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  await submitAction(button.dataset.action);
});

$("submit-vote").addEventListener("click", async () => {
  await submitAction("vote");
});

async function submitAction(type) {
  if (!roomCode || !room || !currentUser) return;

  const role = myRole();
  const targetUid = $("target-select").value;
  const phase = room.phase;

  if (phase === "night") {
    const allowed = (
      (type === "kill" && role === "Mafia") ||
      (type === "protect" && role === "Doctor") ||
      (type === "investigate" && role === "Detective")
    );

    if (!allowed) {
      showNotice("Your role can't perform that action.", true);
      return;
    }
  } else if (phase === "voting" && type !== "vote") {
    return;
  } else if (phase !== "voting" && phase !== "night") {
    return;
  }

  const self = me();

  if (!self || self.alive === false) {
    showNotice("Eliminated players can't submit actions.", true);
    return;
  }

  if (!targetUid) {
    showNotice("Choose a player first.", true);
    return;
  }

  const target = players.find(player => player.id === targetUid);

  if (!target || target.alive === false || targetUid === currentUser.uid) {
    showNotice("Choose a living player other than yourself.", true);
    return;
  }

  const existing = myAction &&
    myAction.phase === phase &&
    myAction.round === room.round;

  if (existing) {
    showNotice("You've already submitted an action this phase.", true);
    return;
  }

  try {
    await setDoc(actionRef(currentUser.uid), {
      uid: currentUser.uid,
      type,
      targetUid,
      phase,
      round: room.round,
      updatedAt: serverTimestamp()
    });

    showNotice(type === "vote" ? "Vote submitted." : "Night action submitted.");
  } catch (error) {
    showNotice(`Couldn't submit action: ${friendlyError(error)}`, true);
  }
}

/* -------------------- HOST GAME RESOLUTION -------------------- */

function currentActions(phase) {
  return Object.entries(actionsByUid)
    .filter(([, action]) =>
      action.phase === phase &&
      action.round === room?.round
    )
    .map(([uid, action]) => ({ uid, ...action }));
}

function hasSubmitted(uid, phase) {
  const action = actionsByUid[uid];

  return Boolean(
    action &&
    action.phase === phase &&
    action.round === room?.round
  );
}

function requiredNightActors() {
  return players.filter(player => {
    if (player.alive === false) return false;

    const role = privateByUid[player.id]?.role;
    return ["Mafia", "Doctor", "Detective"].includes(role);
  });
}

function allRequiredActionsSubmitted() {
  if (!room || !isHost()) return false;

  if (room.phase === "night") {
    const actors = requiredNightActors();

    return actors.length > 0 &&
      actors.every(player => hasSubmitted(player.id, "night"));
  }

  if (room.phase === "voting") {
    const voters = alivePlayers();

    return voters.length > 0 &&
      voters.every(player => hasSubmitted(player.id, "voting"));
  }

  return false;
}

function maybeResolvePhase() {
  if (
    !room ||
    !isHost() ||
    resolving ||
    room.phase === "finished" ||
    room.phase === "lobby"
  ) {
    return;
  }

  const expired = secondsUntil(room.endsAt) <= 0;
  const complete = allRequiredActionsSubmitted();

  if (expired || complete) {
    resolvePhase();
  }
}

async function checkWinner() {
  const living = alivePlayers();

  const mafiaAlive = living.filter(player =>
    privateByUid[player.id]?.role === "Mafia"
  ).length;

  const townAlive = living.length - mafiaAlive;

  if (mafiaAlive === 0) return "Town";
  if (mafiaAlive >= townAlive) return "Mafia";

  return null;
}

async function revealEliminatedPlayer(uid) {
  const player = players.find(item => item.id === uid);
  if (!player) return;

  await updateDoc(playerRef(uid), {
    alive: false,
    ready: false,
    roleReveal: room.settings?.revealRoles === false
      ? null
      : (privateByUid[uid]?.role || null)
  });
}

async function clearActions() {
  await Promise.all(
    Object.keys(actionsByUid).map(uid =>
      deleteDoc(actionRef(uid)).catch(() => {})
    )
  );

  actionsByUid = {};
  myAction = null;
}

async function beginPhase(phase, seconds, round = room.round) {
  await clearActions();

  await updateDoc(roomRef(), {
    phase,
    round,
    endsAt: timestampAfter(seconds),
    updatedAt: serverTimestamp()
  });
}

async function finishGame(winner) {
  await updateDoc(roomRef(), {
    phase: "finished",
    winner,
    endsAt: null,
    updatedAt: serverTimestamp()
  });

  await clearActions();
  showNotice(winner === "Town" ? "The Town has won!" : "The Mafia has won!");
}

async function resolvePhase() {
  if (!isHost() || !room || resolving) return;

  const phase = room.phase;
  const round = room.round;
  const key = `${phase}-${round}`;

  if (!["night", "discussion", "voting"].includes(phase)) return;

  resolving = true;

  try {
    const latestSnapshot = await getDoc(roomRef());
    if (!latestSnapshot.exists()) return;

    const latestRoom = latestSnapshot.data();
    if (
      latestRoom.hostUid !== currentUser.uid ||
      latestRoom.phase !== phase ||
      latestRoom.round !== round
    ) {
      return;
    }

    room = latestRoom;
    if (phase === "discussion") {
      await beginPhase("voting", VOTING_SECONDS, round);
      return;
    }

    if (phase === "night") {
      const nightActions = currentActions("night");

      const mafiaVotes = nightActions.filter(action =>
        action.type === "kill" &&
        privateByUid[action.uid]?.role === "Mafia" &&
        players.some(player => player.id === action.uid && player.alive !== false) &&
        players.some(player => player.id === action.targetUid && player.alive !== false) &&
        !(privateByUid[action.uid]?.mafiaTeammates || []).includes(action.targetUid)
      );

      const doctorActions = nightActions.filter(action =>
        action.type === "protect" &&
        privateByUid[action.uid]?.role === "Doctor" &&
        players.some(player => player.id === action.uid && player.alive !== false) &&
        players.some(player => player.id === action.targetUid && player.alive !== false)
      );

      const detectiveActions = nightActions.filter(action =>
        action.type === "investigate" &&
        privateByUid[action.uid]?.role === "Detective" &&
        players.some(player => player.id === action.uid && player.alive !== false) &&
        players.some(player => player.id === action.targetUid && player.alive !== false)
      );

      let killedUid = null;

      if (mafiaVotes.length) {
        const counts = {};

        mafiaVotes.forEach(action => {
          counts[action.targetUid] = (counts[action.targetUid] || 0) + 1;
        });

        const highest = Math.max(...Object.values(counts));
        const topTargets = Object.keys(counts).filter(
          uid => counts[uid] === highest
        );

        killedUid = topTargets[Math.floor(Math.random() * topTargets.length)];
      }

      const protectedUids = new Set(
        doctorActions.map(action => action.targetUid)
      );

      if (killedUid && !protectedUids.has(killedUid)) {
        await revealEliminatedPlayer(killedUid);
      }

      for (const action of detectiveActions) {
        const targetRole = privateByUid[action.targetUid]?.role;
        const result = targetRole === "Mafia"
          ? `${playerName(action.targetUid)} is Mafia.`
          : `${playerName(action.targetUid)} is not Mafia.`;

        await setDoc(privateRef(action.uid), {
          ...privateByUid[action.uid],
          investigationResult: result
        });
      }

      const winner = await checkWinner();

      if (winner) {
        await finishGame(winner);
        return;
      }

      await beginPhase("discussion", DISCUSSION_SECONDS, round);
      return;
    }

    if (phase === "voting") {
      const votes = currentActions("voting").filter(action =>
        action.type === "vote" &&
        players.some(player =>
          player.id === action.uid && player.alive !== false
        ) &&
        players.some(player =>
          player.id === action.targetUid && player.alive !== false
        )
      );

      const counts = {};

      votes.forEach(action => {
        counts[action.targetUid] = (counts[action.targetUid] || 0) + 1;
      });

      let eliminatedUid = null;

      if (Object.keys(counts).length) {
        const highest = Math.max(...Object.values(counts));
        const topTargets = Object.keys(counts).filter(
          uid => counts[uid] === highest
        );

        // A tied vote means nobody is eliminated.
        if (topTargets.length === 1) {
          eliminatedUid = topTargets[0];
        }
      }

      if (eliminatedUid) {
        await revealEliminatedPlayer(eliminatedUid);
      }

      const winner = await checkWinner();

      if (winner) {
        await finishGame(winner);
        return;
      }

      await beginPhase("night", NIGHT_SECONDS, round + 1);
    }
  } catch (error) {
    console.error("Game resolution failed:", key, error);
    showNotice(`Couldn't advance the game: ${friendlyError(error)}`, true);
  } finally {
    resolving = false;
  }
}

/* -------------------- LEAVING THE ROOM -------------------- */

$("leave-room").addEventListener("click", async () => {
  await leaveCurrentRoom(true);
});

async function leaveCurrentRoom(returnHome = true) {
  if (!roomCode || !currentUser || leavingRoom) return;

  leavingRoom = true;

  const code = roomCode;
  const uid = currentUser.uid;
  const wasHost = room?.hostUid === uid;

  try {
    const remaining = players.filter(player => player.id !== uid);
    const nextHost = remaining[0]?.id || null;

    await runTransaction(db, async transaction => {
      const ref = roomRef(code);
      const snapshot = await transaction.get(ref);

      if (!snapshot.exists()) return;

      const data = snapshot.data();
      const members = (data.memberUids || []).filter(
        memberUid => memberUid !== uid
      );

      const update = {
        memberUids: members,
        updatedAt: serverTimestamp()
      };

      if (wasHost) {
        update.hostUid = nextHost;
      }

      transaction.update(ref, update);
    });

    await Promise.all([
      deleteDoc(playerRef(uid, code)).catch(() => {}),
      deleteDoc(privateRef(uid, code)).catch(() => {}),
      deleteDoc(actionRef(uid, code)).catch(() => {})
    ]);

    disconnectRoomListeners();

    roomCode = null;
    room = null;
    players = [];
    privateByUid = {};
    actionsByUid = {};
    myAction = null;

    if (returnHome) {
      showScreen("home");
      showNotice("You left the room.");
    }
  } catch (error) {
    showNotice(`Couldn't leave room: ${friendlyError(error)}`, true);
  } finally {
    leavingRoom = false;
  }
}
