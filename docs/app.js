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
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";

// --------------------------------------------------
// FIREBASE
// --------------------------------------------------

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
const functions = getFunctions(app, "europe-west1");

const call = (name, data) =>
  httpsCallable(functions, name)(data).then(result => result.data);

// --------------------------------------------------
// DOM HELPERS
// --------------------------------------------------

const $ = id => document.getElementById(id);

function on(id, eventName, handler) {
  const element = $(id);
  if (element) element.addEventListener(eventName, handler);
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function setHidden(id, hidden) {
  const element = $(id);
  if (element) element.classList.toggle("hidden", hidden);
}

const screens = {
  auth: $("auth-screen"),
  home: $("home-screen"),
  game: $("game-screen")
};

// --------------------------------------------------
// APPLICATION STATE
// --------------------------------------------------

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

let profile = {
  displayName: "",
  avatarData: ""
};

let signupAvatarData = "";
let editAvatarData = "";

// --------------------------------------------------
// SCREENS AND NOTIFICATIONS
// --------------------------------------------------

function showScreen(name) {
  Object.entries(screens).forEach(([key, element]) => {
    if (element) {
      element.classList.toggle("hidden", key !== name);
    }
  });
}

function notify(message, type = "") {
  const box = $("notice");
  if (!box) return;

  box.textContent = message;
  box.className = `notice ${type}`.trim();
  box.classList.remove("hidden");
}

function clearNotice() {
  $("notice")?.classList.add("hidden");
}

function friendlyError(error) {
  const messages = {
    "auth/email-already-in-use":
      "That email already has an account.",

    "auth/invalid-email":
      "Please enter a valid email address.",

    "auth/invalid-credential":
      "Email or password is incorrect.",

    "auth/weak-password":
      "Choose a stronger password.",

    "auth/too-many-requests":
      "Too many attempts. Please try again later.",

    "auth/requires-recent-login":
      "For security, sign in again before changing those account details.",

    "functions/unauthenticated":
      "Please sign in again.",

    "functions/permission-denied":
      "You aren't allowed to do that.",

    "functions/not-found":
      "That room could not be found.",

    "functions/failed-precondition":
      "That action isn't available right now.",

    "functions/resource-exhausted":
      "The room is full or temporarily unavailable.",

    "permission-denied":
      "Firebase denied that operation. Check your Firestore rules.",

    "unavailable":
      "Firebase is temporarily unavailable. Try again shortly."
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

    if (successMessage) {
      notify(successMessage, "success");
    }
  } catch (error) {
    console.error(error);
    notify(friendlyError(error), "error");
  } finally {
    busy = false;
  }
}

// --------------------------------------------------
// PROFILE: AVATARS AND IMAGE COMPRESSION
// --------------------------------------------------

function renderAvatar(element, imageData, name = "") {
  if (!element) return;

  element.replaceChildren();

  if (imageData) {
    const image = document.createElement("img");
    image.src = imageData;
    image.alt = name ? `${name}'s profile picture` : "Profile picture";
    element.append(image);
  } else {
    element.textContent =
      (name || "?").trim().slice(0, 1).toUpperCase() || "?";
  }
}

async function compressImage(file) {
  if (!file || !file.type.startsWith("image/")) {
    throw new Error("Please choose an image file.");
  }

  const image = new Image();
  const objectUrl = URL.createObjectURL(file);

  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => {
        reject(new Error("Couldn't open that image."));
      };
      image.src = objectUrl;
    });

    const maxSide = 256;
    const scale = Math.min(
      1,
      maxSide / Math.max(image.width, image.height)
    );

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));

    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Your browser couldn't process that image.");
    }

    context.drawImage(
      image,
      0,
      0,
      canvas.width,
      canvas.height
    );

    let quality = 0.8;
    let result = canvas.toDataURL("image/jpeg", quality);

    while (result.length > 120000 && quality > 0.25) {
      quality -= 0.1;
      result = canvas.toDataURL("image/jpeg", quality);
    }

    if (result.length > 150000) {
      throw new Error(
        "That picture is too large to save. Try another image."
      );
    }

    return result;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// --------------------------------------------------
// PROFILE: FIRESTORE STORAGE
// --------------------------------------------------

async function saveProfileDocument(displayName, avatarData) {
  if (!currentUser) {
    throw new Error("Please sign in before saving your profile.");
  }

  await setDoc(doc(db, "users", currentUser.uid), {
    displayName,
    avatarData,
    updatedAt: serverTimestamp()
  });
}

async function loadProfile(user) {
  const profileRef = doc(db, "users", user.uid);
  const snapshot = await getDoc(profileRef);

  if (snapshot.exists()) {
    const saved = snapshot.data();

    profile = {
      displayName: saved.displayName || "",
      avatarData: saved.avatarData || ""
    };
  } else {
    const emailName = (user.email || "").split("@")[0];

    profile = {
      displayName:
        (user.displayName || emailName || "Player").slice(0, 18),
      avatarData: ""
    };
  }

  renderProfile();
}

function renderProfile() {
  const displayName = profile.displayName || "Player";

  setText("profile-display-name", displayName);
  setText("profile-email", currentUser?.email || "");

  renderAvatar(
    $("profile-avatar"),
    profile.avatarData,
    displayName
  );

  const playerNameInput = $("player-name");

  if (playerNameInput) {
    playerNameInput.value = profile.displayName;
  }
}

function openProfileEditor() {
  if (!currentUser) return;

  const nameInput = $("edit-display-name");
  const emailInput = $("edit-email");
  const currentPasswordInput = $("current-password");
  const newPasswordInput = $("new-password");

  if (nameInput) nameInput.value = profile.displayName;
  if (emailInput) emailInput.value = currentUser.email || "";

  if (currentPasswordInput) currentPasswordInput.value = "";
  if (newPasswordInput) newPasswordInput.value = "";

  editAvatarData = profile.avatarData;

  renderAvatar(
    $("edit-avatar-preview"),
    editAvatarData,
    profile.displayName
  );

  setHidden("profile-editor", false);
}

async function saveProfileChanges() {
  if (!currentUser) {
    throw new Error("Please sign in again.");
  }

  const displayName = $("edit-display-name")?.value.trim() || "";
  const email = $("edit-email")?.value.trim() || "";
  const currentPassword = $("current-password")?.value || "";
  const newPassword = $("new-password")?.value || "";

  if (displayName.length < 2 || displayName.length > 18) {
    throw new Error(
      "Your display name must be between 2 and 18 characters."
    );
  }

  if (!email) {
    throw new Error("Enter a valid email address.");
  }

  if (newPassword && newPassword.length < 6) {
    throw new Error(
      "Your new password must be at least 6 characters."
    );
  }

  const emailChanged = email !== currentUser.email;
  const passwordChanged = newPassword.length > 0;

  if (emailChanged || passwordChanged) {
    if (!currentPassword) {
      throw new Error(
        "Enter your current password to change your email or password."
      );
    }

    if (!currentUser.email) {
      throw new Error(
        "This account doesn't have a password-based email login."
      );
    }

    const credential = EmailAuthProvider.credential(
      currentUser.email,
      currentPassword
    );

    await reauthenticateWithCredential(currentUser, credential);

    if (emailChanged) {
      await updateEmail(currentUser, email);
    }

    if (passwordChanged) {
      await updatePassword(currentUser, newPassword);
    }
  }

  await saveProfileDocument(displayName, editAvatarData);

  profile = {
    displayName,
    avatarData: editAvatarData
  };

  renderProfile();

  setHidden("profile-editor", true);

  const editAvatarInput = $("edit-avatar");
  if (editAvatarInput) editAvatarInput.value = "";

  notify("Your profile has been updated!", "success");
}

// --------------------------------------------------
// PROFILE: SIGNUP
// --------------------------------------------------

on("signup", "click", event => {
  event.preventDefault();

  const signupFields = $("signup-fields");

  // First click opens the extra signup fields.
  if (signupFields && signupFields.classList.contains("hidden")) {
    signupFields.classList.remove("hidden");

    const nameInput = $("signup-name");
    if (nameInput) {
      nameInput.required = true;
      nameInput.focus();
    }

    setText("signup", "Finish sign up");
    return;
  }

  runAction(async () => {
    const email = $("email")?.value.trim() || "";
    const password = $("password")?.value || "";

    const nameInput = $("signup-name");
    const playerNameInput = $("player-name");

    const fallbackName =
      playerNameInput?.value.trim() ||
      email.split("@")[0] ||
      "Player";

    const displayName = (
      nameInput?.value.trim() || fallbackName
    ).slice(0, 18);

    if (!email || !password) {
      throw new Error(
        "Enter your email address and password first."
      );
    }

    if (displayName.length < 2 || displayName.length > 18) {
      throw new Error(
        "Your display name must be between 2 and 18 characters."
      );
    }

    const credential = await createUserWithEmailAndPassword(
      auth,
      email,
      password
    );

    currentUser = credential.user;

    try {
      await saveProfileDocument(displayName, signupAvatarData);

      profile = {
        displayName,
        avatarData: signupAvatarData
      };

      renderProfile();

      notify("Account created! Your profile is ready.", "success");
    } catch (error) {
      console.error("Profile save failed:", error);

      notify(
        "Your account was created, but the profile couldn't be saved. Check your Firestore rules.",
        "error"
      );
    }

    signupAvatarData = "";

    const avatarInput = $("signup-avatar");
    if (avatarInput) avatarInput.value = "";

    if (signupFields) signupFields.classList.add("hidden");

    setText("signup", "Create account");
  });
});

on("signup-avatar", "change", event => {
  runAction(async () => {
    const file = event.target.files?.[0];
    if (!file) return;

    signupAvatarData = await compressImage(file);

    renderAvatar(
      $("signup-avatar-preview"),
      signupAvatarData,
      $("signup-name")?.value || ""
    );
  });
});

on("signup-name", "input", () => {
  if (!signupAvatarData) {
    renderAvatar(
      $("signup-avatar-preview"),
      "",
      $("signup-name")?.value || ""
    );
  }
});

// --------------------------------------------------
// PROFILE: EDITING
// --------------------------------------------------

on("edit-profile-button", "click", openProfileEditor);

on("cancel-profile", "click", () => {
  setHidden("profile-editor", true);

  const avatarInput = $("edit-avatar");
  if (avatarInput) avatarInput.value = "";
});

on("edit-avatar", "change", event => {
  runAction(async () => {
    const file = event.target.files?.[0];
    if (!file) return;

    editAvatarData = await compressImage(file);

    renderAvatar(
      $("edit-avatar-preview"),
      editAvatarData,
      $("edit-display-name")?.value || ""
    );
  });
});

on("edit-display-name", "input", () => {
  if (!editAvatarData) {
    renderAvatar(
      $("edit-avatar-preview"),
      "",
      $("edit-display-name")?.value || ""
    );
  }
});

on("remove-avatar", "click", () => {
  editAvatarData = "";

  const avatarInput = $("edit-avatar");
  if (avatarInput) avatarInput.value = "";

  renderAvatar(
    $("edit-avatar-preview"),
    "",
    $("edit-display-name")?.value || ""
  );
});

on("save-profile", "click", () => {
  runAction(saveProfileChanges);
});

// --------------------------------------------------
// AUTHENTICATION
// --------------------------------------------------

on("auth-form", "submit", event => {
  event.preventDefault();

  runAction(async () => {
    await signInWithEmailAndPassword(
      auth,
      $("email").value.trim(),
      $("password").value
    );
  });
});

on("signout", "click", () => {
  runAction(() => signOut(auth));
});

// --------------------------------------------------
// ROOM CREATION AND JOINING
// --------------------------------------------------

on("create-form", "submit", event => {
  event.preventDefault();

  runAction(async () => {
    const name =
      profile.displayName ||
      $("player-name").value.trim();

    if (!name) {
      throw new Error("Choose a display name first.");
    }

    const result = await call("createRoom", {
      name,
      avatarData: profile.avatarData,
      revealRoles: $("reveal-check").checked
    });

    connectToRoom(result.code);
  });
});

on("join-form", "submit", event => {
  event.preventDefault();

  runAction(async () => {
    const code = $("room-code").value.trim().toUpperCase();

    const name =
      profile.displayName ||
      $("player-name").value.trim();

    if (!name) {
      throw new Error("Choose a display name first.");
    }

    await call("joinRoom", {
      code,
      name,
      avatarData: profile.avatarData
    });

    connectToRoom(code);
  });
});

on("room-code", "input", event => {
  event.target.value = event.target.value
    .replace(/[^a-z]/gi, "")
    .toUpperCase()
    .slice(0, 4);
});

on("copy-code", "click", () => {
  runAction(async () => {
    if (!roomCode) {
      throw new Error("You're not in a room.");
    }

    await navigator.clipboard.writeText(roomCode);
  }, "Room code copied!");
});

// --------------------------------------------------
// ROOM CONTROLS
// --------------------------------------------------

on("ready-check", "change", event => {
  if (!roomCode) return;

  runAction(() => call("setReady", {
    code: roomCode,
    ready: event.target.checked
  }));
});

on("reveal-check", "change", event => {
  if (!roomCode) return;

  runAction(() => call("setSettings", {
    code: roomCode,
    revealRoles: event.target.checked
  }));
});

on("start-game", "click", () => {
  runAction(() => call("startGame", {
    code: roomCode
  }));
});

on("night-buttons", "click", event => {
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

    setText("action-status", "Night action submitted.");
  });
});

on("submit-vote", "click", () => {
  const targetUid = $("target-select").value;

  if (!targetUid) {
    notify("Choose a living player first.", "error");
    return;
  }

  runAction(async () => {
    await call("submitVote", {
      code: roomCode,
      targetUid
    });

    setText("action-status", "Vote submitted.");
  });
});

on("leave-room", "click", () => {
  if (!roomCode) return;

  runAction(async () => {
    await call("leaveRoom", {
      code: roomCode
    });

    resetRoomView();
    showScreen("home");
    clearNotice();
  });
});

// --------------------------------------------------
// ROOM LISTENERS
// --------------------------------------------------

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

function connectToRoom(code) {
  resetRoomView();

  roomCode = code;
  setText("room-code-display", code);
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

      const revealCheck = $("reveal-check");
      if (revealCheck) {
        revealCheck.checked =
          roomData.settings?.revealRoles !== false;
      }

      renderRoom();

      try {
        myState = await call("getMyState", { code });

        if (roomCode === code) {
          renderRoom();
        }
      } catch (error) {
        console.error("Couldn't refresh private state:", error);
      }
    },
    error => notify(friendlyError(error), "error")
  );

  stopPlayersListener = onSnapshot(
    collection(db, "rooms", code, "players"),
    snapshot => {
      players = snapshot.docs.map(d => ({
        uid: d.id,
        ...d.data()
      }));

      renderRoom();
    },
    error => notify(friendlyError(error), "error")
  );

  // Cloud Functions are still responsible for advancing game phases.
  pollHandle = setInterval(() => {
    if (!roomCode || document.hidden) return;

    call("advanceIfDue", {
      code: roomCode
    }).catch(error => {
      console.error("Phase check failed:", error);
    });
  }, 3000);

  timerHandle = setInterval(renderTimer, 250);
}

// --------------------------------------------------
// GAME DISPLAY
// --------------------------------------------------

function phaseDetails(phase) {
  return {
    lobby: [
      "Waiting in lobby",
      "Get everyone ready before the host starts."
    ],

    night: [
      "Nightfall",
      "Special roles, choose your actions in secret."
    ],

    discussion: [
      "Morning discussion",
      "Talk through the clues and decide who seems suspicious."
    ],

    voting: [
      "Voting time",
      "Choose one living player to eliminate."
    ],

    finished: [
      "Game over",
      "The winner has been decided."
    ]
  }[phase] || ["Unknown phase", ""];
}

function renderRoom() {
  if (!roomData) return;

  const [title, description] = phaseDetails(roomData.phase);

  setText("phase-title", title);
  setText("phase-description", description);

  setText(
    "round-label",
    roomData.phase === "lobby"
      ? "Waiting for game to start"
      : `Round ${roomData.round || 1}`
  );

  setText("player-count", `${players.length}/12`);

  const isHost = currentUser?.uid === roomData.hostUid;
  const isLobby = roomData.phase === "lobby";
  const isAlive = myState?.alive === true;

  setHidden("lobby-controls", !isLobby);

  const readyCheck = $("ready-check");
  if (readyCheck) {
    readyCheck.disabled = isHost;
    readyCheck.checked =
      players.find(p => p.uid === currentUser?.uid)?.ready === true;
  }

  setHidden("reveal-setting", !isLobby || !isHost);
  setHidden("start-game", !isLobby || !isHost);

  const startButton = $("start-game");
  if (startButton) {
    startButton.disabled =
      players.length < 5 ||
      players.length > 12 ||
      players.some(p => !p.ready);
  }

  setHidden(
    "action-controls",
    isLobby || roomData.phase === "finished" || !isAlive
  );

  setHidden(
    "finished-card",
    roomData.phase !== "finished"
  );

  setHidden("role-card", !myState?.role);

  setHidden(
    "leave-room",
    roomData.phase === "finished"
  );

  setText(
    "winner-text",
    roomData.winner === "Town"
      ? "The Town wins!"
      : roomData.winner === "Mafia"
        ? "The Mafia wins!"
        : "Game ended."
  );

  if (myState?.role) {
    setText("role-name", myState.role);

    setText(
      "role-description",
      ({
        Mafia:
          "At night, choose a player to eliminate. Work with your fellow Mafia.",

        Townsperson:
          "You have no night action. Use discussion and voting to find the Mafia.",

        Detective:
          "Investigate one player each night to discover whether they are Mafia.",

        Doctor:
          "Protect one player each night from the Mafia's attack."
      })[myState.role] || ""
    );

    setText(
      "team-info",
      myState.role === "Mafia"
        ? "Your fellow Mafia: " +
          (
            myState.mafiaTeammates
              ?.map(p => p.name)
              .join(", ") || "None"
          )
        : ""
    );

    const investigation = myState.investigation;

    setText(
      "investigation-result",
      investigation
        ? `Round ${investigation.round}: ${investigation.targetName} ${
            investigation.isMafia
              ? "is Mafia."
              : "is not Mafia."
          }`
        : ""
    );
  }

  const canNightAct =
    roomData.phase === "night" && isAlive;

  const role = myState?.role;

  setHidden("night-buttons", !canNightAct);

  setHidden(
    "submit-vote",
    roomData.phase !== "voting" || !isAlive
  );

  const actionForRole = ({
    Mafia: "kill",
    Detective: "investigate",
    Doctor: "protect"
  })[role];

  $("night-buttons")?.querySelectorAll("button").forEach(button => {
    button.classList.toggle(
      "hidden",
      !actionForRole || button.dataset.action !== actionForRole
    );
  });

  renderPlayers();
  renderTargets();
  renderTimer();
}

// --------------------------------------------------
// PLAYER LIST
// --------------------------------------------------

function renderPlayers() {
  const list = $("player-list");
  if (!list || !roomData) return;

  list.replaceChildren();

  for (const player of players) {
    const row = document.createElement("div");

    row.className =
      "player" + (player.alive ? "" : " dead");

    const avatar = document.createElement("div");
    avatar.className = "avatar";

    if (player.avatarData) {
      const image = document.createElement("img");
      image.src = player.avatarData;
      image.alt = "";
      avatar.append(image);
    } else {
      avatar.textContent =
        (player.name || "?").slice(0, 1).toUpperCase();
    }

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

    tag.className =
      "tag" +
      (!player.alive
        ? " dead"
        : player.ready
          ? " ready"
          : "");

    tag.textContent = !player.alive
      ? (player.roleReveal || "Dead")
      : roomData.phase === "lobby"
        ? (player.ready ? "READY" : "WAITING")
        : "ALIVE";

    row.append(avatar, meta, tag);
    list.append(row);
  }
}

// --------------------------------------------------
// TARGET SELECTOR
// --------------------------------------------------

function renderTargets() {
  const select = $("target-select");
  if (!select) return;

  const previous = select.value;

  select.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a player...";
  select.append(placeholder);

  for (const player of players) {
    if (!player.alive || player.uid === currentUser?.uid) {
      continue;
    }

    const option = document.createElement("option");
    option.value = player.uid;
    option.textContent = player.name || "Player";

    select.append(option);
  }

  if ([...select.options].some(option => option.value === previous)) {
    select.value = previous;
  }
}

// --------------------------------------------------
// PHASE TIMER
// --------------------------------------------------

function renderTimer() {
  const timer = $("timer");
  if (!timer) return;

  if (
    !roomData?.endsAt ||
    roomData.phase === "lobby" ||
    roomData.phase === "finished"
  ) {
    timer.textContent = "--:--";
    return;
  }

  const endTime =
    typeof roomData.endsAt === "number"
      ? roomData.endsAt
      : typeof roomData.endsAt?.toMillis === "function"
        ? roomData.endsAt.toMillis()
        : Date.parse(roomData.endsAt);

  if (!Number.isFinite(endTime)) {
    timer.textContent = "--:--";
    return;
  }

  const seconds = Math.max(
    0,
    Math.ceil((endTime - Date.now()) / 1000)
  );

  timer.textContent =
    `${String(Math.floor(seconds / 60)).padStart(2, "0")}:` +
    `${String(seconds % 60).padStart(2, "0")}`;
}

// --------------------------------------------------
// AUTH STATE
// --------------------------------------------------

onAuthStateChanged(auth, async user => {
  currentUser = user;

  setHidden("signout", !user);

  if (!user) {
    resetRoomView();

    profile = {
      displayName: "",
      avatarData: ""
    };

    signupAvatarData = "";
    editAvatarData = "";

    showScreen("auth");
    return;
  }

  try {
    await loadProfile(user);
  } catch (error) {
    console.error("Profile loading failed:", error);

    notify(
      "Couldn't load your profile. Check your Firestore rules.",
      "error"
    );
  }

  if (!roomCode) {
    showScreen("home");
  }
});
