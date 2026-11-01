import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js"; 
import { ACHIEVEMENTS, ACHIEVEMENT_CATEGORIES, achievementById, applyTitleDesign, roleTitleColors } from "./achievements.js"; 
import {  
  getAuth,  
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
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
  arrayUnion,
  getDocs
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
await setPersistence(auth, browserLocalPersistence);
const db = getFirestore(app);

const $ = id => document.getElementById(id);

const GAME_LENGTH = 12;
const NIGHT_SECONDS = 35;
const DISCUSSION_SECONDS = 25;
const VOTING_SECONDS = 35;
const MAX_PLAYERS = 12;
const MIN_PLAYERS = 3;

let currentUser = null;
let profile = { displayName: "", avatarData: "", activeTitle: "" };
let pendingSignupAvatar = "";
let myStats = {};
let pendingEditAvatar = null;
let signupMode = false;

let roomCode = null;
let room = null;
let players = [];
let privateByUid = {};
let actionsByUid = {};
let myAction = null;
let selectedTargetUid = null;
let selectionPhaseKey = null;
let activeLobbyTab = "settings";

let unsubRoom = null;
let unsubPlayers = null;
let unsubPrivate = null;
let unsubActions = null;
let unsubMyPrivate = null;
let unsubMyAction = null;
let unsubMafiaIntents = null;
let mafiaIntentsCode = null;
let mafiaIntentsByUid = {};
let hostListenersCode = null;

let timerHandle = null;
let resolving = false;
let leavingRoom = false;
let lastHostHeartbeatAt = 0;
let claimingHost = false;
const activeRoomStorageKey = uid => `mafia_active_room_${uid}`;

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
  setVisible("statistics-screen", screen === "statistics");
  setVisible("achievements-screen", screen === "achievements");
  setVisible("leaderboard-screen", screen === "leaderboard");
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

function mafiaIntentsRef(code = roomCode) {
  return collection(db, "rooms", code, "mafiaIntents");
}

function mafiaIntentRef(uid, code = roomCode) {
  return doc(db, "rooms", code, "mafiaIntents", uid);
}

function syncMafiaIntentListener(code = roomCode) {
  const role = myRole();
  if (!code || !["Mafia", "Silencer"].includes(role)) {
    unsubMafiaIntents?.();
    unsubMafiaIntents = null;
    mafiaIntentsCode = null;
    mafiaIntentsByUid = {};
    return;
  }
  if (mafiaIntentsCode === code && unsubMafiaIntents) return;
  unsubMafiaIntents?.();
  mafiaIntentsCode = code;
  unsubMafiaIntents = onSnapshot(mafiaIntentsRef(code), snapshot => {
    mafiaIntentsByUid = {};
    snapshot.docs.forEach(item => { mafiaIntentsByUid[item.id] = item.data(); });
    renderPlayers();
  }, error => console.warn("Mafia coordination listener unavailable:", error));
  const own = privateByUid[currentUser.uid];
  if (own?.role && ["Mafia", "Silencer"].includes(own.role)) {
    setDoc(mafiaIntentRef(currentUser.uid, code), {
      uid: currentUser.uid, role: own.role, targetUid: null, updatedAt: serverTimestamp()
    }, { merge: true }).catch(error => console.warn("Mafia role sync failed:", error));
  }
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

function phaseDuration(phase) {
  const key = { night: "nightSeconds", discussion: "discussionSeconds", voting: "votingSeconds" }[phase];
  const fallback = { night: NIGHT_SECONDS, discussion: DISCUSSION_SECONDS, voting: VOTING_SECONDS }[phase];
  const value = Number(room?.settings?.[key]);
  return Number.isFinite(value) && value >= 10 && value <= 120 ? value : fallback;
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
  renderPlayerTitle($("profile-active-title"), profile.activeTitle);

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
    activeTitle: profile.activeTitle || "",
    updatedAt: serverTimestamp()
  });
}

async function loadMyStats() {
  const statsRef = doc(db, "leaderboard", currentUser.uid);
  const snapshot = await getDoc(statsRef);
  myStats = snapshot.exists() ? snapshot.data() : {};
  const unlocked = new Set(myStats.unlockedAchievements || []);
  ACHIEVEMENTS.forEach(item => {
    if (item.kind === "wins" && Number(myStats.wins || 0) >= item.target) unlocked.add(item.id);
    if (item.kind === "role" && Number(myStats.roleWins?.[item.role] || 0) >= 1) unlocked.add(item.id);
  });
  const unlockedAchievements = [...unlocked];
  if (unlockedAchievements.length !== (myStats.unlockedAchievements || []).length) {
    await setDoc(statsRef, {
      uid: currentUser.uid,
      unlockedAchievements,
      activeTitle: myStats.activeTitle || profile.activeTitle || ""
    }, { merge: true });
    myStats = { ...myStats, unlockedAchievements };
  }
  renderMyStats(myStats);
}

function renderMyStats(stats) {
  const games = Number(stats?.gamesPlayed || 0);
  const wins = Number(stats?.wins || 0);
  const rate = games ? Math.round((wins / games) * 100) : 0;
  $("my-stat-games").textContent = String(games);
  $("my-stat-wins").textContent = String(wins);
  $("my-stat-rate").textContent = `${rate}%`;
  $("my-stat-progress").style.width = `${rate}%`;
  $("my-stat-role").textContent = stats?.mostPlayedRole || "—";
  $("my-stat-streak").textContent = String(stats?.bestWinStreak || 0);
  $("my-stat-alignment").textContent = stats?.mostPlayedAlignment || "—";
  renderBreakdown($("my-role-breakdown"), stats?.roleGames, stats?.roleWins);
  renderBreakdown($("my-alignment-breakdown"), stats?.alignmentGames, stats?.alignmentWins);
  myStats = stats || {};
  renderAchievements(myStats);
  renderTitleSelector(myStats);
}

function renderPlayerTitle(element, id) {
  if (!element) return;
  applyTitleDesign(element, id);
}

function applyRoleDesign(element, role) {
  if (!element || !role) return;
  const [top, bottom] = roleTitleColors(role);
  element.style.setProperty("--role-accent", top);
  element.style.setProperty("--role-accent-bottom", bottom);
}

function achievementProgress(stats, achievement) {
  if (achievement.kind === "wins") return { value: Number(stats.wins || 0), target: achievement.target };
  if (achievement.kind === "role") return { value: Number(stats.roleWins?.[achievement.role] || 0), target: 1 };
  return { value: (stats.unlockedAchievements || []).includes(achievement.id) ? 1 : 0, target: 1 };
}

let activeAchievementCategory = ACHIEVEMENT_CATEGORIES[0];

function renderAchievements(stats) {
  const container = $("achievement-categories");
  const tabs = $("achievement-tabs");
  if (!container || !tabs) return;
  tabs.replaceChildren();
  container.replaceChildren();
  const unlocked = new Set(stats.unlockedAchievements || []);

  ACHIEVEMENT_CATEGORIES.forEach(category => {
    const categoryItems = ACHIEVEMENTS.filter(item => item.category === category);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "achievement-tab" + (activeAchievementCategory === category ? " is-active" : "");
    button.textContent = category;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(activeAchievementCategory === category));
    button.addEventListener("click", () => {
      activeAchievementCategory = category;
      renderAchievements(stats);
    });
    tabs.append(button);
  });

  const grid = document.createElement("div");
  grid.className = "achievement-grid";
  ACHIEVEMENTS.filter(item => item.category === activeAchievementCategory).forEach(item => {
    const isUnlocked = unlocked.has(item.id);
    const progress = achievementProgress(stats, item);
    const card = document.createElement("article");
    card.className = "achievement-card" + (isUnlocked ? " is-unlocked" : "");
    const title = document.createElement("strong");
    title.textContent = item.name;
    const requirement = document.createElement("p");
    requirement.textContent = item.requirement;
    const reward = document.createElement("span");
    reward.className = "achievement-reward";
    applyTitleDesign(reward, item.id);
    const progressText = document.createElement("span");
    progressText.className = "achievement-progress-text";
    progressText.textContent = item.kind === "wins" || item.kind === "role"
      ? Math.min(progress.value, progress.target) + " / " + progress.target
      : (isUnlocked ? "Completed" : "Not completed");
    const bar = document.createElement("div");
    bar.className = "achievement-progress-track";
    const fill = document.createElement("div");
    fill.className = "achievement-progress-fill";
    fill.style.width = Math.min(100, progress.value / progress.target * 100) + "%";
    bar.append(fill);
    const status = document.createElement("span");
    status.className = "achievement-status";
    status.textContent = isUnlocked ? "UNLOCKED" : "LOCKED";
    card.append(title, requirement, reward, progressText, bar, status);
    grid.append(card);
  });
  container.append(grid);
}

function renderTitleSelector(stats) {
  const select = $("active-title-select");
  if (!select) return;
  const unlocked = (stats.unlockedAchievements || []).map(achievementById).filter(Boolean);
  select.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No title";
  select.append(none);
  unlocked.forEach(item => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.title;
    select.append(option);
  });
  select.value = profile.activeTitle || "";
  select.disabled = !unlocked.length;
}

async function saveActiveTitle(id) {
  if (!currentUser) return;
  const selected = id && (myStats.unlockedAchievements || []).includes(id) ? id : "";
  profile.activeTitle = selected;
  await setDoc(doc(db, "users", currentUser.uid), {
    displayName: getDisplayName(),
    avatarData: profile.avatarData || "",
    activeTitle: selected,
    updatedAt: serverTimestamp()
  }, { merge: true });
  await setDoc(doc(db, "leaderboard", currentUser.uid), {
    uid: currentUser.uid,
    activeTitle: selected
  }, { merge: true });
  if (roomCode) await updateDoc(playerRef(currentUser.uid), { activeTitle: selected });
  renderProfile();
  renderTitleSelector(myStats);
  showNotice(selected ? "Your title has been updated!" : "Your title has been removed.");
}

function renderBreakdown(container, gamesMap, winsMap) {
  if (!container) return;
  container.replaceChildren();
  const entries = Object.entries(gamesMap || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    container.textContent = "No completed games yet.";
    return;
  }
  entries.forEach(([name, games]) => {
    const wins = Number(winsMap?.[name] || 0);
    const row = document.createElement("div");
    row.className = "breakdown-row";
    const label = document.createElement("span");
    label.textContent = name;
    const record = document.createElement("strong");
    record.textContent = `${wins}/${games} wins · ${games ? Math.round(wins / games * 100) : 0}%`;
    row.append(label, record);
    container.append(row);
  });
}

async function loadProfile() {
  const snapshot = await getDoc(doc(db, "users", currentUser.uid));

  if (snapshot.exists()) {
    const data = snapshot.data();
    profile = {
      displayName: cleanName(data.displayName),
      avatarData: data.avatarData || "",
      activeTitle: data.activeTitle || ""
    };
  } else {
    profile = {
      displayName: cleanName(currentUser.email?.split("@")[0]) || "Player",
      avatarData: "",
      activeTitle: ""
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
        avatarData: pendingSignupAvatar || "",
        activeTitle: ""
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
    profile = { displayName: "", avatarData: "", activeTitle: "" };
    showScreen("auth");
    return;
  }

  try {
    await loadProfile();
    await loadMyStats().catch(error => console.warn("Statistics are unavailable until Firestore rules are published:", error));
    const savedRoom = localStorage.getItem(activeRoomStorageKey(user.uid));
    if (savedRoom) connectToRoom(savedRoom);
    else showScreen("home");
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

    profile = { ...profile, displayName, avatarData };
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
            settings: { revealRoles: true, nightSeconds: NIGHT_SECONDS, discussionSeconds: DISCUSSION_SECONDS, votingSeconds: VOTING_SECONDS, roleCounts: { Mafia: 1, Detective: 0, Doctor: 0 } },
            nightDeaths: [],
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
      activeTitle: profile.activeTitle || "",
      ready: false,
      alive: true,
      roleReveal: null,
      joinedAt: serverTimestamp()
    });

    connectToRoom(createdCode);
    showNotice(`Room ${createdCode} created! Share the code with your friends.`);
  } catch (error) {
    console.error("Room creation failed:", error);
    showNotice(`Couldn't create room (${error?.code || "unknown error"}): ${friendlyError(error)}`, true);
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
  let joinStage = "reading room";

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
      joinStage = "adding you to the room";
      await updateDoc(ref, {
        memberUids: arrayUnion(currentUser.uid),
        updatedAt: serverTimestamp()
      });
    }

    joinStage = "creating your player entry";
    await setDoc(playerRef(currentUser.uid, code), {
      uid: currentUser.uid,
      name: getDisplayName(),
      avatarData: profile.avatarData || "",
      activeTitle: profile.activeTitle || "",
      ready: false,
      alive: true,
      roleReveal: null,
      joinedAt: serverTimestamp()
    });

    joinStage = "opening the room";
    connectToRoom(code);
    showNotice(`Joined room ${code}!`);
  } catch (error) {
    console.error("Join room failed during " + joinStage + ":", error);
    showNotice(`Couldn't join room while ${joinStage} (${error?.code || "unknown error"}): ${friendlyError(error)}`, true);
  } finally {
    button.disabled = false;
  }
});

/* -------------------- PLAYER STATISTICS -------------------- */

function alignmentForRole(role) {
  if (["Mafia", "Silencer"].includes(role)) return "Mafia";
  if (["Detective", "Doctor", "Mayor", "Townsperson", "Tracker", "Knight"].includes(role)) return "Town";
  if (role === "Bounty Hunter") return "Neutral";
  return "Neutral";
}

function incrementMap(source, key, amount = 1) {
  return { ...(source || {}), [key]: Number(source?.[key] || 0) + amount };
}

function mostPlayedKey(map) {
  return Object.entries(map || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
}

async function recordMyGameStats() {
  if (!currentUser || !roomCode || !room || room.phase !== "finished") return;
  const code = roomCode;
  const finishedRoom = room;
  const player = players.find(item => item.id === currentUser.uid);
  const privateSnapshot = await getDoc(privateRef(currentUser.uid));
  const privateData = privateSnapshot.exists() ? privateSnapshot.data() : (privateByUid[currentUser.uid] || {});
  const actualRole = privateData.role;
  const role = privateData.roleStolen ? "Thief" : actualRole;
  if (!player || !actualRole || !finishedRoom?.winner) return;

  const alignment = alignmentForRole(actualRole);
  const won = finishedRoom.winner === "Jester"
    ? actualRole === "Jester"
    : finishedRoom.winner === "Bounty Hunter"
      ? actualRole === "Bounty Hunter" && (finishedRoom.bountyHunterWinnerUids || []).includes(currentUser.uid)
      : finishedRoom.winner === alignment && alignment !== "Neutral";
  const finalResults = Array.isArray(finishedRoom.finalResults) ? finishedRoom.finalResults : [];
  const ownResult = finalResults.find(item => item.uid === currentUser.uid) || {};
  const mafiaStarting = finalResults.filter(item => ["Mafia", "Silencer"].includes(item.startingRole));
  const gameFlags = {
    day1TownVoteOut: ownResult.eliminationMethod === "vote" && ownResult.eliminatedRound === 1 && ownResult.alignment === "Town",
    day1MafiaVoteOut: ownResult.eliminationMethod === "vote" && ownResult.eliminatedRound === 1 && ownResult.alignment === "Mafia",
    doctorVoteOut: ownResult.eliminationMethod === "vote" && actualRole === "Doctor",
    unanimousVoteOut: ownResult.unanimousVote === true,
    nightOneCasualty: ownResult.eliminationMethod === "night" && ownResult.eliminatedRound === 1,
    fatalDiscovery: ownResult.fatalDiscovery === true || privateData.fatalDiscovery === true,
    silentVerdict: won && alignment === "Town" && Number(privateData.incorrectVotes || 0) === 0,
    cleanSweep: won && alignment === "Mafia" && mafiaStarting.length >= 2 && mafiaStarting.every(item => item.alive),
    sherlocksIntuition: privateData.sherlocksIntuition === true,
    muzzled: privateData.muzzled === true,
    clutchSave: new Set(privateData.clutchSavedUids || []).size >= 2,
    bountyHunterWin: actualRole === "Bounty Hunter" && (finishedRoom.bountyHunterWinnerUids || []).includes(currentUser.uid)
  };

  const statsRef = doc(db, "leaderboard", currentUser.uid);
  const gameRef = doc(db, "leaderboard", currentUser.uid, "games", finishedRoom.gameId || code);
  let newlyUnlocked = [];

  await runTransaction(db, async transaction => {
    const statsSnapshot = await transaction.get(statsRef);
    const gameSnapshot = await transaction.get(gameRef);
    if (gameSnapshot.exists()) return;

    const old = statsSnapshot.exists() ? statsSnapshot.data() : {};
    const gamesPlayed = Number(old.gamesPlayed || 0) + 1;
    const wins = Number(old.wins || 0) + (won ? 1 : 0);
    const roleGames = incrementMap(old.roleGames, role);
    const roleWins = incrementMap(old.roleWins, role, won ? 1 : 0);
    const alignmentGames = incrementMap(old.alignmentGames, alignment);
    const alignmentWins = incrementMap(old.alignmentWins, alignment, won ? 1 : 0);
    const currentWinStreak = won ? Number(old.currentWinStreak || 0) + 1 : 0;
    const bestWinStreak = Math.max(Number(old.bestWinStreak || 0), currentWinStreak);
    const unlocked = new Set(old.unlockedAchievements || []);

    ACHIEVEMENTS.forEach(item => {
      let achieved = false;
      if (item.kind === "wins") achieved = wins >= item.target;
      else if (item.kind === "role") achieved = Number(roleWins[item.role] || 0) >= 1;
      else achieved = Boolean(gameFlags[item.flag]);
      if (achieved) unlocked.add(item.id);
    });

    newlyUnlocked = [...unlocked].filter(id => !(old.unlockedAchievements || []).includes(id));
    transaction.set(statsRef, {
      uid: currentUser.uid,
      displayName: player.name || getDisplayName(),
      avatarData: player.avatarData || profile.avatarData || "",
      gamesPlayed,
      wins,
      losses: gamesPlayed - wins,
      winRate: gamesPlayed ? wins / gamesPlayed : 0,
      roleGames,
      roleWins,
      alignmentGames,
      alignmentWins,
      mostPlayedRole: mostPlayedKey(roleGames),
      mostPlayedAlignment: mostPlayedKey(alignmentGames),
      currentWinStreak,
      bestWinStreak,
      unlockedAchievements: [...unlocked],
      activeTitle: old.activeTitle || profile.activeTitle || "",
      updatedAt: serverTimestamp()
    });
    transaction.set(gameRef, {
      roomCode: code,
      role,
      alignment,
      winner: finishedRoom.winner,
      won,
      unlockedAchievements: newlyUnlocked,
      completedAt: serverTimestamp()
    });
  });

  await loadMyStats();
  if (newlyUnlocked.length) {
    const names = newlyUnlocked.map(id => achievementById(id)?.name).filter(Boolean);
    showNotice("Achievement unlocked: " + names.join(", "));
  }
}

function openStatistics() {
  showScreen("statistics");
}

function closeStatistics() {
  showScreen("home");
}

function openAchievements() {
  showScreen("achievements");
  renderAchievements(myStats);
  renderTitleSelector(myStats);
}

function closeAchievements() {
  showScreen("home");
}

function openLeaderboard() {
  showScreen("leaderboard");
  loadLeaderboard();
}

function closeLeaderboard() {
  showScreen("home");
}

async function loadLeaderboard() {
  const list = $("leaderboard-list");
  list.textContent = "Loading leaderboard…";
  try {
    const snapshot = await getDocs(collection(db, "leaderboard"));
    const entries = snapshot.docs
      .map(item => ({ uid: item.id, ...item.data() }))
      .filter(item => Number(item.gamesPlayed || 0) > 0)
      .sort((a, b) =>
        Number(b.wins || 0) - Number(a.wins || 0) ||
        Number(b.gamesPlayed || 0) - Number(a.gamesPlayed || 0)
      );

    list.replaceChildren();
    if (!entries.length) {
      list.textContent = "No completed games yet. Be the first onto the leaderboard!";
      return;
    }

    entries.forEach((entry, index) => {
      const row = document.createElement("summary");
      row.className = "leaderboard-row";
      const rank = document.createElement("strong");
      rank.className = "leaderboard-rank";
      rank.textContent = `#${index + 1}`;
      const avatar = document.createElement("div");
      avatar.className = "profile-avatar leaderboard-avatar";
      renderAvatar(avatar, entry.avatarData || "", entry.displayName || "Player");
      const identity = document.createElement("div");
      identity.className = "leaderboard-identity";
      const name = document.createElement("strong");
      name.textContent = entry.displayName || "Player";
      const title = document.createElement("span");
      title.className = "leaderboard-title";
      applyTitleDesign(title, entry.activeTitle);
      const detail = document.createElement("span");
      detail.textContent = `${entry.gamesPlayed || 0} games played`;
      identity.append(name, title, detail);
      const rate = document.createElement("strong");
      rate.className = "leaderboard-wins";
      rate.textContent = `${Number(entry.wins || 0)} wins`;
      row.append(rank, avatar, identity, rate);

      const wrapper = document.createElement("details");
      wrapper.className = "leaderboard-entry";
      row.setAttribute("aria-label", `View ${entry.displayName || "player"} leaderboard record`);
      const breakdown = document.createElement("div");
      breakdown.className = "leaderboard-breakdown";
      const roleHeading = document.createElement("strong");
      roleHeading.textContent = "By role";
      const roleRows = document.createElement("div");
      roleRows.className = "breakdown-list";
      renderBreakdown(roleRows, entry.roleGames, entry.roleWins);
      const alignmentHeading = document.createElement("strong");
      alignmentHeading.textContent = "By alignment";
      const alignmentRows = document.createElement("div");
      alignmentRows.className = "breakdown-list";
      renderBreakdown(alignmentRows, entry.alignmentGames, entry.alignmentWins);
      breakdown.append(roleHeading, roleRows, alignmentHeading, alignmentRows);
      wrapper.append(row, breakdown);
      list.append(wrapper);
    });
  } catch (error) {
    list.textContent = `Couldn't load leaderboard: ${friendlyError(error)}`;
  }
}

$("final-results-home").addEventListener("click", () => {
  leaveCurrentRoom(true);
});

$("statistics-button").addEventListener("click", openStatistics);
$("achievements-button").addEventListener("click", openAchievements);
$("achievements-back").addEventListener("click", closeAchievements);
$("active-title-select").addEventListener("change", event => {
  saveActiveTitle(event.target.value).catch(error => showNotice(friendlyError(error), true));
});
$("statistics-back").addEventListener("click", closeStatistics);
$("leaderboard-button").addEventListener("click", openLeaderboard);
$("leaderboard-back").addEventListener("click", closeLeaderboard);

/* -------------------- ROOM LISTENERS -------------------- */

function disconnectRoomListeners() {
  unsubRoom?.();
  unsubPlayers?.();
  unsubPrivate?.();
  unsubActions?.();
  unsubMyPrivate?.();
  unsubMyAction?.();
  unsubMafiaIntents?.();

  unsubRoom = null;
  unsubPlayers = null;
  unsubPrivate = null;
  unsubActions = null;
  unsubMyPrivate = null;
  unsubMyAction = null;
  unsubMafiaIntents = null;
  mafiaIntentsCode = null;
  mafiaIntentsByUid = {};
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
  if (currentUser) localStorage.setItem(activeRoomStorageKey(currentUser.uid), code);
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
      if (currentUser) localStorage.removeItem(activeRoomStorageKey(currentUser.uid));
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
      if (currentUser) localStorage.removeItem(activeRoomStorageKey(currentUser.uid));
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
    if (room.phase === "finished") recordMyGameStats().catch(error => console.error("Stats update failed:", error));
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
        syncMafiaIntentListener(code);
        renderGame();
        if (room?.phase === "finished") recordMyGameStats().catch(error => console.error("Stats update failed:", error));
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
    syncMafiaIntentListener(code);

    renderGame();
    if (room?.phase === "finished") recordMyGameStats().catch(error => console.error("Stats update failed:", error));
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
  setVisible("game-grid", !inLobby && phase !== "finished");
  setVisible("final-results", phase === "finished");
  if (phase === "finished") renderFinalResults();

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
    voting: room.voteStage === "tiebreaker" ? "Tie-breaker vote" : "Time to vote",
    finished: "Game over"
  };

  const phaseDescriptions = {
    lobby: host
      ? "You're hosting. Wait for everyone to join and ready up."
      : "Wait for the host to start once everyone is ready.",
    night: "The town is asleep. Your role determines what you can do.",
    discussion: role === "Knight" ? "Talk it out. You can challenge one player during discussion." : "Talk it out. Who seems suspicious?",
    voting: room.voteStage === "tiebreaker"
      ? "The vote was tied. Choose between the tied players, or abstain."
      : "Choose the player you think should be eliminated, or abstain.",
    finished: "The game has ended. See who survived."
  };

  $("phase-title").textContent = phaseTitles[phase] || "Game in progress";
  $("phase-description").textContent = room.challengeNotice && phase === "discussion"
    ? room.challengeNotice
    : (phaseDescriptions[phase] || "");

  const nightDeaths = Array.isArray(room.nightDeaths) ? room.nightDeaths : [];
  const announcement = $("night-announcement");
  if (announcement) {
    announcement.classList.toggle("hidden", phase !== "discussion" || !Array.isArray(room.nightDeaths));
    announcement.textContent = nightDeaths.length
      ? nightDeaths.map(item => item.name || playerName(item.uid)).join(", ") + (nightDeaths.length === 1 ? " died during the night." : " died during the night.")
      : "Nobody died during the night.";
  }
  const isSpectator = !inLobby && phase !== "finished" && self?.alive === false;
  setVisible("spectator-notice", isSpectator);
  if (isSpectator) {
    $("spectator-notice").textContent = "SPECTATOR MODE · You've been eliminated. You can watch the rest of the game, but you can't take part in normal actions.";
  }
  $("round-label").textContent = phase === "lobby"
    ? "Lobby"
    : phase === "finished"
      ? `Final round: ${room.round || 1}`
      : `Round ${room.round || 1}`;

  setVisible("lobby-controls", inLobby);
  setVisible("action-controls", !isSpectator && (phase === "night" || phase === "voting" || (phase === "discussion" && role === "Knight" && !privateByUid[currentUser.uid]?.knightChallengeUsed)));
  setVisible("finished-card", phase === "finished");
  setVisible("role-card", Boolean(role) && !inLobby);

  // Ready status is available to all lobby members.
  $("ready-check").checked = Boolean(self?.ready);
  $("ready-check").disabled = !inLobby;

  // Reveal settings and Start Game are host-only.
  setVisible("reveal-setting", inLobby && host);
  $("reveal-check").checked = room.settings?.revealRoles !== false;
  $("reveal-check").disabled = !host || !inLobby;

  setVisible("timer-settings", inLobby && host);
  [
    ["night-duration", "nightSeconds", NIGHT_SECONDS],
    ["discussion-duration", "discussionSeconds", DISCUSSION_SECONDS],
    ["voting-duration", "votingSeconds", VOTING_SECONDS]
  ].forEach(([id, key, fallback]) => {
    const input = $(id);
    if (!input) return;
    if (document.activeElement !== input) input.value = String(room.settings?.[key] ?? fallback);
    input.disabled = !host || !inLobby;
  });

  const roleCounts = getRoleCounts();
  let selectedRoleTotal = 0;
  ["Mafia", "Silencer", "Detective", "Doctor", "Mayor", "Tracker", "Knight", "Jester", "Thief", "Bounty Hunter"].forEach(role => {
    const count = roleCounts[role];
    const input = $(roleCountInputId(role));
    input.value = String(count);
    input.disabled = !host || !inLobby;
    selectedRoleTotal += count;
  });
  renderRoleRoster();
  const roleCountsValid = Object.entries(roleCounts).every(([role, count]) =>
    Number.isInteger(count) && count >= 0 && count <= MAX_PLAYERS
  ) && selectedRoleTotal <= players.length &&
    (roleCounts.Mafia + roleCounts.Silencer >= 1) &&
    !(roleCounts.Silencer > 0 && roleCounts.Mafia < 1);

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
        description: "Each night, vote with the Mafia to eliminate a player.",
        team: "You win when the Mafia equal or outnumber the Town."
      },
      Silencer: {
        description: "Each night, choose a player who will be unable to vote the following day. You are part of the Mafia team.",
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
      Mayor: {
        description: "Your daytime vote counts twice. Use it carefully to help the Town identify the Mafia.",
        team: "You win when all Mafia members are eliminated."
      },
      Tracker: {
        description: "Each night, follow one living player. At the start of discussion, learn whether they visited anyone.",
        team: "You win by helping the Town eliminate the Mafia."
      },
      Knight: {
        description: "During discussion, challenge one living player once per game. If they are Mafia or Neutral, they are eliminated. If they are Town, you are eliminated and the game skips voting, going straight to nightfall.",
        team: "You win by helping the Town eliminate the Mafia."
      },
      "Bounty Hunter": {
        description: "You have a randomly assigned target. You win if that player is eliminated by the daytime vote.",
        team: "Your target is " + playerName(privateByUid[currentUser.uid]?.bountyTargetUid) + ". You are Neutral."
      },
      Jester: {
        description: "You win immediately if the Town eliminates you in the daytime vote. You have no night action.",
        team: "You win only by being eliminated by the daytime vote."
      },
      Thief: {
        description: `Each night, steal tokens from one living player. Town gives 1, Mafia gives 2, and Neutral gives 3. You have ${privateByUid[currentUser.uid]?.thiefTokens || 0}/5 tokens. Once you reach 5, choose a deceased player and permanently become their role.`,
        team: "You are Neutral. After stealing a role, you take on that role's win condition."
      },
      Townsperson: {
        description: "You have no special night action. Use discussion and voting to find the Mafia.",
        team: "You win when all Mafia are eliminated."
      }
    };

    $("role-name").textContent = role;
    $("role-description").textContent = roleInfo[role]?.description || "";
    $("team-info").textContent = roleInfo[role]?.team || "";
    const roleCard = $("role-card");
    roleCard.dataset.role = role.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    applyRoleDesign(roleCard, role);
    const mafiaPanel = $("mafia-team-panel");
    if (mafiaPanel) {
      const isMafiaAligned = ["Mafia", "Silencer"].includes(role);
      mafiaPanel.classList.toggle("hidden", !isMafiaAligned);
      mafiaPanel.replaceChildren();
      if (isMafiaAligned) {
        applyRoleDesign(mafiaPanel, "Mafia");
        const heading = document.createElement("strong");
        heading.textContent = "YOUR MAFIA TEAM";
        const members = document.createElement("div");
        members.className = "mafia-team-members";
        const teammateUids = [
          ...new Set([currentUser.uid, ...(privateByUid[currentUser.uid]?.mafiaTeammates || [])])
        ];
        teammateUids.forEach(uid => {
          const player = players.find(item => item.id === uid);
          if (!player) return;
          const memberRole = uid === currentUser.uid
            ? role
            : (mafiaIntentsByUid[uid]?.role || "Mafia");
          const member = document.createElement("div");
          member.className = "mafia-team-member";
          const avatar = document.createElement("div");
          avatar.className = "profile-avatar mafia-team-avatar";
          renderAvatar(avatar, player.avatarData || "", player.name || "Player");
          const details = document.createElement("div");
          details.className = "mafia-team-member-details";
          const name = document.createElement("span");
          name.className = "mafia-team-member-name";
          name.textContent = uid === currentUser.uid ? `${player.name || "You"} (You)` : (player.name || "Mafia");
          const roleLabel = document.createElement("span");
          roleLabel.className = "mafia-team-member-role";
          roleLabel.textContent = memberRole;
          applyRoleDesign(roleLabel, memberRole);
          details.append(name, roleLabel);
          member.append(avatar, details);
          members.append(member);
        });
        mafiaPanel.append(heading, members);
      }
    }
    const targetPanel = $("bounty-target-panel");
    if (targetPanel) {
      targetPanel.classList.toggle("hidden", role !== "Bounty Hunter");
      targetPanel.replaceChildren();
      if (role === "Bounty Hunter") {
        applyRoleDesign(targetPanel, role);
        const targetUid = privateByUid[currentUser.uid]?.bountyTargetUid;
        const target = players.find(player => player.id === targetUid);
        const heading = document.createElement("strong");
        heading.textContent = "TARGET";
        const avatar = document.createElement("div");
        avatar.className = "profile-avatar bounty-target-avatar";
        renderAvatar(avatar, target?.avatarData || "", target?.name || "Target");
        const targetName = document.createElement("span");
        targetName.textContent = target?.name || "Assigned target";
        targetPanel.append(heading, avatar, targetName);
      }
    }

    const investigation = privateByUid[currentUser.uid]?.investigationResult;
    const tracking = privateByUid[currentUser.uid]?.trackerResult;
    $("investigation-result").textContent = [investigation, tracking].filter(Boolean).join(" ");

    if (
      ["Mafia", "Silencer"].includes(role) &&
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
    $("role-card").removeAttribute("data-role");
    $("role-card").style.removeProperty("--role-accent");
    if ($("bounty-target-panel")) $("bounty-target-panel").classList.add("hidden");
    if ($("mafia-team-panel")) {
      $("mafia-team-panel").classList.add("hidden");
      $("mafia-team-panel").replaceChildren();
    }
  }

  const winnerMessage = room.winner === "Mafia"
    ? "The Mafia win."
    : room.winner === "Town"
      ? "The Town wins."
      : room.winner === "Jester"
        ? "The Jester wins!"
        : room.winner === "Bounty Hunter"
          ? "The Bounty Hunter wins!"
          : "Game over";
  $("winner-text").textContent = winnerMessage;
  if ($("final-winner-heading")) $("final-winner-heading").textContent = winnerMessage;

  renderTargetOptions();
  renderPlayers();
  renderActionControls();
  renderTimer();

  if (phase === "lobby") {
    $("action-status").textContent = "";
  }
}

const ROLE_GUIDE = {
  Mafia: {
    alignment: "Mafia",
    ability: "Each night, the Mafia collectively choose one living player to eliminate. Mafia members cannot target their own teammates.",
    win: "The Mafia win when the number of living Mafia members equals or exceeds the number of living Town members.",
    notes: "You work with the other Mafia members. Your goal is to outnumber the Town."
  },
  Silencer: {
    alignment: "Mafia",
    ability: "Each night, choose one living player to silence. That player cannot vote during the following daytime vote. If no ordinary Mafia members remain alive, the Silencer takes over the Mafia's nightly elimination.",
    win: "The Mafia win when the number of living Mafia members equals or exceeds the number of living Town members.",
    notes: "You are part of the Mafia team and can see your fellow Mafia teammates."
  },
  Detective: {
    alignment: "Town",
    ability: "Each night, investigate one living player to learn whether they are Mafia.",
    win: "Help the Town eliminate every Mafia member.",
    notes: "Your investigation result is private to you."
  },
  Doctor: {
    alignment: "Town",
    ability: "Each night, protect one living player from the Mafia's attack. A successful protection prevents that night's elimination.",
    win: "Help the Town eliminate every Mafia member."
  },
  Mayor: {
    alignment: "Town",
    ability: "Your vote during the daytime elimination vote counts twice.",
    win: "Help the Town eliminate every Mafia member."
  },
  Townsperson: {
    alignment: "Town",
    ability: "You have no special night action. Take part in discussion and vote during the day to identify and eliminate the Mafia.",
    win: "The Town wins when every Mafia member has been eliminated."
  },
  Jester: {
    alignment: "Neutral",
    ability: "You have no night action. Your aim is to get the Town to eliminate you in the daytime vote.",
    win: "You win immediately if you are eliminated by the daytime vote. Being eliminated at night does not trigger your win."
  },
  Tracker: {
    alignment: "Town",
    ability: "Each night, choose one living player to follow. At the start of discussion, learn whether they visited anyone during the night.",
    win: "Help the Town eliminate every Mafia member.",
    notes: "Your tracking result is private to you."
  },
  Knight: {
    alignment: "Town",
    ability: "During discussion, choose one living player and challenge their role once per game. If they are Mafia or Neutral, they are eliminated and discussion resumes with the remaining time. If they are Town, you are eliminated and the game skips voting, going straight to nightfall.",
    win: "Help the Town eliminate every Mafia member."
  },
  "Bounty Hunter": {
    alignment: "Neutral",
    ability: "You receive one randomly assigned target at the start of the game. You have no night action.",
    win: "You win if your assigned target is eliminated through the daytime vote.",
    notes: "Your target is private. If they are eliminated at night, you do not win."
  },
  Thief: {
    alignment: "Neutral",
    ability: "Each night, choose one living player to steal from. Stealing from a Town player earns 1 token, a Mafia player earns 2 tokens, and a Neutral player earns 3 tokens. Once you have at least 5 tokens, you can choose a deceased player and permanently take their role and abilities. Your Thief role is replaced and you cannot steal tokens or change roles again.",
    win: "While you are the Thief, you are Neutral and have no separate team win condition. After taking a role, you adopt that role's alignment and win condition.",
    notes: "Your token total is private. The role you inherit is permanent."
  }
};

function showRoleGuide(role) {
  const info = ROLE_GUIDE[role];
  if (!info) return;

  const modal = $("role-info-modal");
  $("role-info-title").textContent = role;
  $("role-info-alignment").textContent = info.alignment + " alignment";
  $("role-info-ability").textContent = info.ability;
  $("role-info-win").textContent = info.win;
  $("role-info-notes").textContent = info.notes || "";
  setVisible("role-info-notes-row", Boolean(info.notes));
  setVisible("role-info-modal", true);
  $("role-info-close").focus();
}

function closeRoleGuide() {
  setVisible("role-info-modal", false);
}

$("role-info-close").addEventListener("click", closeRoleGuide);
$("role-info-modal").addEventListener("click", event => {
  if (event.target === $("role-info-modal")) closeRoleGuide();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("role-info-modal").classList.contains("hidden")) {
    closeRoleGuide();
  }
});

async function startRematch() {
  if (!isHost() || room?.phase !== "finished" || !currentUser) return;
  try {
    const snapshot = await getDocs(playersRef());
    const allPlayers = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    const returning = allPlayers.filter(player => player.playAgain || player.id === currentUser.uid);
    if (returning.length < MIN_PLAYERS) {
      showNotice(`At least ${MIN_PLAYERS} players need to opt in for a rematch.`, true);
      return;
    }
    const returningUids = returning.map(player => player.id);
    const leaving = allPlayers.filter(player => !returningUids.includes(player.id));
    await Promise.all(leaving.map(async player => {
      await deleteDoc(playerRef(player.id)).catch(() => {});
      await deleteDoc(privateRef(player.id)).catch(() => {});
      await deleteDoc(actionRef(player.id)).catch(() => {});
      await deleteDoc(mafiaIntentRef(player.id)).catch(() => {});
    }));
    await Promise.all(returning.map(player => updateDoc(playerRef(player.id), {
      ready: false, alive: true, playAgain: false, roleReveal: null,
      originalRoleReveal: null, eliminationMethod: null, eliminatedRound: null,
      eliminatedPhase: null, unanimousVote: false, fatalDiscovery: false
    })));
    await updateDoc(roomRef(), {
      memberUids: returningUids, phase: "lobby", round: 0, winner: null,
      gameId: crypto.randomUUID(),
      finalResults: [], bountyHunterWinnerUids: [], nightDeaths: [], endsAt: null,
      voteStage: null, tiedPlayerUids: [], discussionPaused: false,
      pausedSecondsRemaining: null, challengeNotice: null, updatedAt: serverTimestamp()
    });
    showNotice("Rematch lobby opened! Everyone who opted in is back in the lobby.");
  } catch (error) {
    showNotice(`Couldn't start rematch: ${friendlyError(error)}`, true);
  }
}

$("play-again-button").addEventListener("click", async () => {
  if (!currentUser || room?.phase !== "finished") return;
  const nextValue = !Boolean(me()?.playAgain);
  try {
    await updateDoc(playerRef(currentUser.uid), { playAgain: nextValue });
    if (isHost() && nextValue) await startRematch();
  } catch (error) {
    showNotice(`Couldn't update rematch choice: ${friendlyError(error)}`, true);
  }
});

$("start-rematch-button").addEventListener("click", startRematch);

function renderFinalResults() {
  const list = $("final-player-roles");
  if (!list) return;
  list.replaceChildren();

  const savedResults = Array.isArray(room?.finalResults) ? room.finalResults : [];
  const results = savedResults.length
    ? savedResults
    : players.map(player => {
        const role = player.roleReveal || "Unknown";
        const alignment = alignmentForRole(role);
        const won = room?.winner === "Jester"
          ? role === "Jester"
          : room?.winner === alignment && alignment !== "Neutral";
        return {
          uid: player.id, name: player.name, role,
          originalRole: player.originalRoleReveal || null,
          alignment, alive: player.alive !== false, won
        };
      });

  const alignmentOrder = ["Mafia", "Town", "Neutral"];
  alignmentOrder.forEach(alignment => {
    const groupResults = results.filter(result => result.alignment === alignment);
    if (!groupResults.length) return;

    const group = document.createElement("section");
    group.className = "final-alignment-group";
    const heading = document.createElement("h3");
    heading.className = "final-alignment-heading";
    heading.textContent = alignment;
    group.append(heading);

    const cards = document.createElement("div");
    cards.className = "final-alignment-cards";
    groupResults.forEach(result => {
      const player = players.find(item => item.id === result.uid);
      const card = document.createElement("article");
      card.className = "final-role-player";
      if (result.won) card.classList.add("is-winner");

      const avatar = document.createElement("div");
      avatar.className = "profile-avatar final-role-avatar";
      renderAvatar(avatar, player?.avatarData || "", result.name || "Player");

      const details = document.createElement("div");
      details.className = "final-role-details";
      const name = document.createElement("strong");
      name.className = "final-role-name";
      name.textContent = result.name || "Player";
      const title = document.createElement("span");
      title.className = "final-player-title";
      applyTitleDesign(title, result.activeTitle || player?.activeTitle);
      const role = document.createElement("span");
      role.className = "final-role-nameplate";
      role.textContent = result.role || "Role unavailable";
      details.append(name, title, role);

      if (result.originalRole === "Thief") {
        const original = document.createElement("span");
        original.className = "final-role-original";
        original.textContent = "(originally Thief)";
        details.append(original);
      }

      const status = document.createElement("span");
      status.className = "final-role-status";
      status.textContent = result.alive ? "Survived" : "Eliminated";
      details.append(status);
      if (result.won) {
        const winner = document.createElement("span");
        winner.className = "final-role-winner-label";
        winner.textContent = "WINNER";
        details.append(winner);
      }
      card.append(avatar, details);
      cards.append(card);
    });
    group.append(cards);
    list.append(group);
  });

  const optedIn = players.filter(player => player.playAgain).length;
  const playButton = $("play-again-button");
  const startButton = $("start-rematch-button");
  if (playButton) {
    const opted = Boolean(me()?.playAgain);
    playButton.textContent = opted ? "Cancel Play Again" : "Play Again";
    playButton.classList.toggle("is-selected", opted);
  }
  if (startButton) {
    setVisible("start-rematch-button", isHost());
    startButton.textContent = `Start Rematch (${optedIn + (me()?.playAgain ? 0 : 1)} players)`;
    startButton.disabled = !isHost() || (optedIn + (me()?.playAgain ? 0 : 1)) < MIN_PLAYERS;
  }
  const status = $("rematch-status");
  if (status) status.textContent = `${optedIn} player${optedIn === 1 ? "" : "s"} ready to play again. ${isHost() ? "Choose Play Again, then start the rematch when you're ready." : "Wait for the host to start the rematch."}`;
}

function renderRoleRoster() {
  const roster = $("lobby-role-roster");
  if (!roster) return;

  const counts = getRoleCounts();
  const alignments = [
    { name: "MAFIA", roles: [{ role: "Mafia", emoji: "🔪" }, { role: "Silencer", emoji: "🤫" }] },
    { name: "TOWN", roles: [
      { role: "Detective", emoji: "🔎" },
      { role: "Doctor", emoji: "🏥" },
      { role: "Mayor", emoji: "⚖️" },
      { role: "Tracker", emoji: "👣" },
      { role: "Knight", emoji: "⚔️" },
      { role: "Townsperson", emoji: "🧍" }
    ] },
    { name: "NEUTRAL", roles: [
      { role: "Jester", emoji: "🃏" },
      { role: "Thief", emoji: "🪙" },
      { role: "Bounty Hunter", emoji: "🎯" }
    ] }
  ];

  roster.replaceChildren();

  alignments.forEach(alignment => {
    const group = document.createElement("div");
    group.className = "lobby-role-alignment";
    const heading = document.createElement("strong");
    heading.className = "lobby-role-alignment-title";
    heading.textContent = alignment.name;
    group.append(heading);

    alignment.roles.forEach(({ role, emoji }) => {
      const count = counts[role] || 0;
      if (count < 1) return;
      const item = document.createElement("button");
      item.type = "button";
      item.className = "lobby-role-item";
      item.textContent = `${emoji} ${role} ×${count}`;
      item.setAttribute("aria-label", `View ${role} role information`);
      item.addEventListener("click", () => showRoleGuide(role));
      group.append(item);
    });

    if (group.querySelector(".lobby-role-item")) roster.append(group);
  });

  if (!roster.childElementCount) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "No roles configured yet.";
    roster.append(empty);
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
      const title = document.createElement("span");
      title.className = "player-card-title";
      applyTitleDesign(title, player.activeTitle);

      card.append(avatarWrap, name, title);

      if (container.id === "player-list" && ["Mafia", "Silencer"].includes(myRole())) {
        const privateRole = mafiaIntentsByUid[player.id]?.role;
        if (privateRole && player.id !== currentUser.uid) {
          const teamRole = document.createElement("span");
          teamRole.className = "mafia-team-role";
          teamRole.textContent = privateRole;
          teamRole.dataset.role = privateRole.toLowerCase().replace(/[^a-z0-9]+/g, "-");
          applyRoleDesign(teamRole, privateRole);
          card.append(teamRole);
        }
        const proposers = Object.values(mafiaIntentsByUid)
          .filter(intent => intent.targetUid === player.id)
          .map(intent => players.find(person => person.id === intent.uid)?.name || "Mafia");
        if (proposers.length) {
          card.classList.add("is-mafia-proposed-target");
          const proposal = document.createElement("span");
          proposal.className = "mafia-proposal-label";
          proposal.textContent = proposers.length === 1 ? `Chosen by ${proposers[0]}` : `Chosen by ${proposers.join(", ")}`;
          card.append(proposal);
        }
      }

      const actionCandidates = getActionCandidates();
      const canSelect = actionCandidates.some(candidate => candidate.id === player.id);
      const actionLocked = myAction &&
        myAction.phase === room?.phase &&
        myAction.round === room?.round;
      const actionEligible = me()?.alive !== false &&
        Boolean(getCurrentActionType()) &&
        !(room?.phase === "voting" &&
          privateByUid[currentUser?.uid]?.silencedRound === room?.round);

      if (container.id === "player-list" && canSelect) {
        card.classList.add("is-action-candidate");
        card.classList.toggle("is-selected-target", selectedTargetUid === player.id);
        card.setAttribute("role", "button");
        card.setAttribute("aria-pressed", String(selectedTargetUid === player.id));
        card.setAttribute("aria-disabled", String(!actionEligible || Boolean(actionLocked)));
        card.tabIndex = actionEligible && !actionLocked ? 0 : -1;
        card.addEventListener("click", () => {
          if (!actionEligible || actionLocked) return;
          selectedTargetUid = player.id;
          if (room?.phase === "night" && ["Mafia", "Silencer"].includes(myRole()) && getCurrentActionType() === "kill") {
            setDoc(mafiaIntentRef(currentUser.uid), {
              uid: currentUser.uid, role: myRole(), targetUid: player.id, updatedAt: serverTimestamp()
            }, { merge: true }).catch(error => showNotice(`Couldn't share Mafia target: ${friendlyError(error)}`, true));
          }
          renderPlayers();
          renderActionControls();
        });
        card.addEventListener("keydown", event => {
          if ((event.key === "Enter" || event.key === " ") && actionEligible && !actionLocked) {
            event.preventDefault();
            card.click();
          }
        });
      }

          if (isDead) {
        const status = document.createElement("span");
        status.className = "player-card-status";
        status.textContent = room?.phase === "finished" ? "Eliminated" : "Spectating";
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
        badge.className = "role-badge role-reveal-badge";
        badge.textContent = player.roleReveal;
        badge.dataset.role = player.roleReveal.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        applyRoleDesign(badge, player.roleReveal);
        card.append(badge);
      }

      container.append(card);
    });
  });
}

function getCurrentActionType() {
  if (room?.phase === "voting") return "vote";
  const role = myRole();
  if (room?.phase === "discussion") return role === "Knight" && !privateByUid[currentUser?.uid]?.knightChallengeUsed ? "challenge" : null;
  if (room?.phase !== "night") return null;
  if (
    role === "Silencer" &&
    !players.some(player =>
      player.alive !== false && privateByUid[player.id]?.role === "Mafia"
    )
  ) {
    return "kill";
  }

  if (role === "Thief") {
    const data = privateByUid[currentUser?.uid] || {};
    const deadRoleTargets = players.filter(player =>
      player.alive === false && privateByUid[player.id]?.role && privateByUid[player.id]?.role !== "Thief"
    );
    return (data.thiefTokens || 0) >= 5 && !data.roleStolen && deadRoleTargets.length
      ? "stealRole"
      : "steal";
  }

  return ({
    Mafia: "kill",
    Silencer: "silence",
    Doctor: "protect",
    Detective: "investigate",
    Tracker: "track"
  })[role] || null;
}

function getActionCopy(type) {
  return ({
    challenge: {
      kind: "KNIGHT CHALLENGE",
      title: "Challenge a player's role",
      hint: "Choose one living player. If they are Mafia or Neutral, they are eliminated. If they are Town, you are eliminated and the game skips the vote.",
      button: "Challenge this player",
      locked: "Your challenge has been submitted."
    },
    track: {
      kind: "TRACKER ACTION",
      title: "Who will you follow?",
      hint: "Choose one living player. At discussion, you will learn whether they visited anyone tonight.",
      button: "Track player",
      locked: "Your target is locked in."
    },
    vote: {
      kind: "DAYTIME VOTE",
      title: "Who should be eliminated?",
      hint: room?.voteStage === "tiebreaker"
        ? "Choose between the tied players, then lock in your vote."
        : "Choose the player you suspect, then lock in your vote. You can also abstain.",
      button: "Lock in vote",
      locked: "Your vote is locked in."
    },
    kill: {
      kind: "MAFIA ACTION",
      title: "Choose your target",
      hint: "Select who the Mafia should target tonight, then lock it in.",
      button: "Lock in target",
      locked: "Your target is locked in."
    },
    protect: {
      kind: "DOCTOR ACTION",
      title: "Who will you protect?",
      hint: "Choose a player to protect tonight, then lock it in.",
      button: "Lock in protection",
      locked: "Your protection is locked in."
    },
    silence: {
      kind: "SILENCER ACTION",
      title: "Who will you silence?",
      hint: "Choose a player who will be unable to vote tomorrow, then lock in your choice.",
      button: "Lock in silence",
      locked: "Your silence target is locked in."
    },
    investigate: {
      kind: "DETECTIVE ACTION",
      title: "Who will you investigate?",
      hint: "Choose a player to investigate tonight, then lock it in.",
      button: "Lock in investigation",
      locked: "Your investigation is locked in."
    },
    steal: {
      kind: "THIEF ACTION",
      title: "Who will you steal from?",
      hint: "Choose one living player. You secretly gain tokens based on their alignment.",
      button: "Lock in theft",
      locked: "Your theft is locked in."
    },
    stealRole: {
      kind: "THIEF REWARD",
      title: "Whose role will you take?",
      hint: "Choose a deceased player. You will permanently replace your Thief role with theirs.",
      button: "Steal role",
      locked: "Your new role has been selected."
    }
  })[type] || {
    kind: "YOUR ACTION",
    title: "Choose a player",
    hint: "Select a player, then lock in your choice.",
    button: "Lock in choice",
    locked: "Your action is locked in."
  };
}

function getActionCandidates() {
  const role = myRole();
  const phase = room?.phase;
  const selfUid = currentUser?.uid;
  if (phase === "night" && role === "Thief") {
    if (getCurrentActionType() === "stealRole") {
      return players.filter(player =>
        player.alive === false && privateByUid[player.id]?.role && privateByUid[player.id]?.role !== "Thief"
      );
    }
    return alivePlayers().filter(player => player.id !== selfUid);
  }
  let candidates = alivePlayers();

  if (phase === "night" && ["Mafia", "Silencer"].includes(role)) {
    const teammates = privateByUid[selfUid]?.mafiaTeammates || [];
    candidates = candidates.filter(player =>
      player.id !== selfUid && !teammates.includes(player.id)
    );
  } else if (phase === "voting") {
    candidates = candidates.filter(player => player.id !== selfUid);
    if (room?.voteStage === "tiebreaker") {
      const tiedUids = room?.tiedPlayerUids || [];
      candidates = candidates.filter(player => tiedUids.includes(player.id));
    }
  } else if (phase === "discussion" && role === "Knight") {
    candidates = candidates.filter(player => player.id !== selfUid);
  } else if (phase === "night" && ["Detective", "Doctor", "Silencer", "Tracker"].includes(role)) {
    candidates = candidates.filter(player => player.id !== selfUid);
  } else {
    candidates = [];
  }

  return candidates;
}

function renderTargetOptions() {
  const phaseKey = `${room?.phase}-${room?.round}`;
  if (selectionPhaseKey !== phaseKey) {
    selectionPhaseKey = phaseKey;
    selectedTargetUid = null;
  }
  if (!getActionCandidates().some(player => player.id === selectedTargetUid)) {
    selectedTargetUid = null;
  }
}

function renderActionControls() {
  const phase = room?.phase;
  const role = myRole();
  const self = me();
  const alive = self?.alive !== false;
  const type = getCurrentActionType();
  const currentAction = myAction &&
    myAction.phase === phase &&
    myAction.round === room?.round
      ? myAction
      : null;
  const silenced = phase === "voting" && privateByUid[currentUser?.uid]?.silencedRound === room?.round;
  const eligible = alive && Boolean(type) && !silenced;
  const copy = getActionCopy(type);
  const challengeNote = $("knight-challenge-note");
  if (challengeNote) {
    challengeNote.classList.toggle("hidden", phase !== "discussion" || role !== "Knight" || !eligible);
    challengeNote.textContent = privateByUid[currentUser?.uid]?.knightChallengeUsed
      ? "You have already used your challenge."
      : "Choose a player from the Players list, then challenge their role. You can do this once per game.";
  }
  const abstainButton = $("abstain-vote");
  if (abstainButton) {
    abstainButton.classList.toggle("hidden", phase !== "voting" || !eligible);
    abstainButton.disabled = !eligible || Boolean(currentAction);
  }

  $("action-kind").textContent = copy.kind;
  $("action-selection-title").textContent = copy.title;
  $("action-selection-hint").textContent = eligible
    ? `${copy.hint} Select a player from the Players list.`
    : copy.hint;
  $("lock-action").textContent = copy.button;
  $("lock-action").disabled =
    !eligible || Boolean(currentAction) || !selectedTargetUid ||
    !getActionCandidates().some(player => player.id === selectedTargetUid);

  const selectable = eligible && !currentAction;
  document.querySelectorAll("#player-list .player-card.is-action-candidate").forEach(card => {
    card.setAttribute("aria-disabled", String(!selectable));
    card.tabIndex = selectable ? 0 : -1;
  });

  if (currentAction) {
    $("action-status").textContent = currentAction.type === "abstain"
      ? "You have abstained from this vote."
      : copy.locked;
  } else if (!alive && !["lobby", "finished"].includes(phase)) {
    $("action-status").textContent =
      "You've been eliminated. You can watch, but you can't act.";
  } else if (silenced) {
    $("action-status").textContent = "You have been silenced and cannot vote this round.";
  } else if (phase === "night" && !eligible) {
    $("action-status").textContent = "Your role has no action tonight.";
  } else {
    $("action-status").textContent =
      eligible ? "Your action only counts once you lock it in. No lock-in by the end of the timer means you abstain." : "";
  }
}

function renderTimer() {
  if (room?.phase === "discussion" && room.discussionPaused) {
    $("timer").textContent = "PAUSED";
    return;
  }
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

["night-duration", "discussion-duration", "voting-duration"].forEach(id => {
  $(id).addEventListener("change", async event => {
    if (!isHost() || room?.phase !== "lobby") return;
    const key = { "night-duration": "nightSeconds", "discussion-duration": "discussionSeconds", "voting-duration": "votingSeconds" }[id];
    const value = Math.max(10, Math.min(120, Math.round(Number(event.target.value) / 5) * 5));
    event.target.value = String(value);
    try {
      await updateDoc(roomRef(), {
        settings: { ...(room.settings || {}), [key]: value },
        updatedAt: serverTimestamp()
      });
    } catch (error) {
      showNotice(friendlyError(error), true);
      event.target.value = String(room.settings?.[key] || phaseDuration(key.replace("Seconds", "")));
    }
  });
});

const ROLE_NAMES = ["Mafia", "Silencer", "Detective", "Doctor", "Mayor", "Tracker", "Knight", "Jester", "Thief", "Bounty Hunter", "Townsperson"];

function roleCountInputId(role) {
  return "role-count-" + role.toLowerCase().replace(/\s+/g, "-");
}

function getRoleCounts() {
  const saved = room?.settings?.roleCounts || {};
  const counts = {
    Mafia: Number.isInteger(saved.Mafia) ? saved.Mafia : 1,
    Silencer: Number.isInteger(saved.Silencer) ? saved.Silencer : 0,
    Detective: Number.isInteger(saved.Detective) ? saved.Detective : 0,
    Doctor: Number.isInteger(saved.Doctor) ? saved.Doctor : 0,
    Mayor: Number.isInteger(saved.Mayor) ? saved.Mayor : 0,
    Tracker: Number.isInteger(saved.Tracker) ? saved.Tracker : 0,
    Knight: Number.isInteger(saved.Knight) ? saved.Knight : 0,
    Jester: Number.isInteger(saved.Jester) ? saved.Jester : 0,
    Thief: Number.isInteger(saved.Thief) ? saved.Thief : 0,
    "Bounty Hunter": Number.isInteger(saved["Bounty Hunter"]) ? saved["Bounty Hunter"] : 0
  };
  counts.Townsperson = Math.max(0, players.length - Object.values(counts).reduce((sum, count) => sum + count, 0));
  return counts;
}

async function saveRoleCounts() {
  if (!isHost() || room?.phase !== "lobby") return;
  const roleCounts = {};
  for (const role of ["Mafia", "Silencer", "Detective", "Doctor", "Mayor", "Tracker", "Knight", "Jester", "Thief", "Bounty Hunter"]) {
    const input = $(roleCountInputId(role));
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

["Mafia", "Silencer", "Detective", "Doctor", "Mayor", "Tracker", "Knight", "Jester", "Thief", "Bounty Hunter"].forEach(role => {
  $(roleCountInputId(role)).addEventListener("change", saveRoleCounts);
});

// Mobile-friendly +/- controls for host role counts.
$("role-count-settings").addEventListener("click", event => {
  const button = event.target.closest("[data-role-step]");
  if (!button || button.disabled) return;
  const input = $("role-count-" + button.dataset.roleStep);
  if (!input || input.disabled) return;
  const current = Number(input.value || 0);
  const next = Math.max(0, Math.min(MAX_PLAYERS, current + Number(button.dataset.step)));
  input.value = String(next);
  input.dispatchEvent(new Event("change", { bubbles: true }));
});


// Apply a role preset to the host's lobby settings.
$("role-preset-select").addEventListener("change", async event => {
  const preset = event.target.value;
  if (!preset || !isHost() || room?.phase !== "lobby") return;

  const presets = {
    classic: { Mafia: 1, Silencer: 0, Detective: 1, Doctor: 1, Mayor: 0, Tracker: 0, Knight: 0, Jester: 0, Thief: 0, "Bounty Hunter": 0 },
    "loud-quiet": { Mafia: 1, Silencer: 1, Detective: 1, Doctor: 0, Mayor: 1, Tracker: 0, Knight: 0, Jester: 1, Thief: 0, "Bounty Hunter": 0 }
  };
  const counts = presets[preset];
  if (!counts) return;

  for (const [role, count] of Object.entries(counts)) {
    const input = $(roleCountInputId(role));
    if (input) input.value = String(count);
  }
  await saveRoleCounts();
  event.target.value = "";
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

    if (roleCounts.Silencer > 0 && roleCounts.Mafia < 1) {
      throw new Error("You need at least one standard Mafia member when using a Silencer.");
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
      .filter(([, role]) => ["Mafia", "Silencer"].includes(role))
      .map(([uid]) => uid);

    const writes = players.map(async player => {
      const role = roleAssignments.get(player.id);
      const bountyTarget = role === "Bounty Hunter"
        ? shuffle(players.filter(candidate => candidate.id !== player.id))[0]
        : null;

      await setDoc(privateRef(player.id), {
        role,
        startingRole: role,
        investigationResult: "",
        trackerResult: "",
        incorrectVotes: 0,
        voteHistory: [],
        clutchSavedUids: [],
        clutchSaves: 0,
        silenceStreakTargetUid: null,
        silenceStreakCount: 0,
        muzzled: false,
        sherlocksIntuition: false,
        fatalDiscovery: false,
        bountyTargetUid: bountyTarget?.id || null,
        knightChallengeUsed: false,
        mafiaTeammates: ["Mafia", "Silencer"].includes(role)
          ? mafiaUids.filter(uid => uid !== player.id)
          : [],
        thiefTokens: 0,
        roleStolen: false,
        originalRole: null
      });

      await updateDoc(playerRef(player.id), {
        ready: false,
        alive: true,
        roleReveal: null,
        eliminationMethod: null,
        eliminatedRound: null,
        eliminatedPhase: null,
        unanimousVote: false,
        fatalDiscovery: false
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
      gameId: crypto.randomUUID(),
      endsAt: timestampAfter(phaseDuration("night")),
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

$("lock-action").addEventListener("click", async () => {
  const type = getCurrentActionType();
  if (!type || !selectedTargetUid) return;
  await submitAction(type, selectedTargetUid);
});

$("abstain-vote").addEventListener("click", async () => {
  if (room?.phase !== "voting" || getCurrentActionType() !== "vote") return;
  await submitAction("abstain", "__abstain__");
});

async function submitAction(type, targetUid) {
  if (!roomCode || !room || !currentUser) return;

  const role = myRole();
  const phase = room.phase;

  if (phase === "night") {
    const allowed = (
      (type === "kill" && (role === "Mafia" || (role === "Silencer" && !players.some(player => player.alive !== false && privateByUid[player.id]?.role === "Mafia")))) ||
      (type === "silence" && role === "Silencer" && players.some(player => player.alive !== false && privateByUid[player.id]?.role === "Mafia")) ||
      (type === "protect" && role === "Doctor") ||
      (type === "investigate" && role === "Detective") ||
      (type === "track" && role === "Tracker") ||
      (type === "steal" && role === "Thief" && getCurrentActionType() === "steal") ||
      (type === "stealRole" && role === "Thief" && getCurrentActionType() === "stealRole")
    );

    if (!allowed) {
      showNotice("Your role can't perform that action.", true);
      return;
    }
  } else if (phase === "voting" && !["vote", "abstain"].includes(type)) {
    return;
  } else if (phase === "discussion" && !(type === "challenge" && role === "Knight" && !privateByUid[currentUser.uid]?.knightChallengeUsed)) {
    return;
  } else if (phase !== "voting" && phase !== "night" && phase !== "discussion") {
    return;
  }

  const self = me();

  if (phase === "voting" && privateByUid[currentUser.uid]?.silencedRound === room.round) {
    showNotice("You have been silenced and cannot vote this round.", true);
    return;
  }

  if (!self || self.alive === false) {
    showNotice("Eliminated players can't submit actions.", true);
    return;
  }

  const abstaining = phase === "voting" && type === "abstain";
  if (phase === "discussion" && type === "challenge" && privateByUid[currentUser.uid]?.knightChallengeUsed) {
    showNotice("You have already used your challenge.", true);
    return;
  }
  if (!targetUid) {
    showNotice("Choose a player first.", true);
    return;
  }

  const target = abstaining ? null : players.find(player => player.id === targetUid);
  const stealingRole = phase === "night" && type === "stealRole";

  if (!abstaining && (!target || targetUid === currentUser.uid ||
      (stealingRole && (target.alive !== false || !privateByUid[targetUid]?.role || privateByUid[targetUid]?.role === "Thief")) ||
      (!stealingRole && target.alive === false))) {
    showNotice(stealingRole ? "Choose a deceased player with an available role." : "Choose a living player other than yourself.", true);
    return;
  }

  if (phase === "voting" && room.voteStage === "tiebreaker" && !abstaining && !(room.tiedPlayerUids || []).includes(targetUid)) {
    showNotice("The tie-breaker is only between the tied players.", true);
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

    selectedTargetUid = null;
    if (phase === "night" && ["Mafia", "Silencer"].includes(role) && type === "kill") {
      await deleteDoc(mafiaIntentRef(currentUser.uid)).catch(() => {});
    }
    showNotice(type === "vote" ? "Vote locked in." : type === "abstain" ? "You've abstained from this vote." : "Action locked in.");
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
    return ["Mafia", "Silencer", "Doctor", "Detective", "Tracker", "Thief"].includes(role);
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
    const voters = alivePlayers().filter(player =>
      privateByUid[player.id]?.silencedRound !== room.round
    );

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

  if (room.phase === "discussion" && room.discussionPaused) return;
  if (room.phase === "discussion" && currentActions("discussion").some(action => action.type === "challenge")) {
    resolvePhase();
    return;
  }
  const expired = secondsUntil(room.endsAt) <= 0;
  const complete = allRequiredActionsSubmitted();

  if (expired || complete) {
    resolvePhase();
  }
}

async function checkWinner() {
  // Resolve win conditions from fresh Firestore data, not potentially stale
  // onSnapshot state. Night actions can update several documents immediately
  // before this check runs.
  const [playerSnapshot, privateSnapshot] = await Promise.all([
    getDocs(playersRef()),
    getDocs(collection(db, "rooms", roomCode, "private"))
  ]);

  players = playerSnapshot.docs.map(item => ({
    id: item.id,
    ...item.data()
  }));

  privateByUid = {};
  privateSnapshot.docs.forEach(item => {
    privateByUid[item.id] = item.data();
  });

  // If role documents have not all arrived yet, do not declare a winner from
  // an incomplete roster (which could incorrectly look like zero Mafia).
  if (players.some(player => !privateByUid[player.id]?.role)) {
    console.warn("Winner check skipped because some player roles are not loaded yet.");
    return null;
  }

  const living = alivePlayers();
  if (!living.length) return null;

  const mafiaAlive = living.filter(player =>
    ["Mafia", "Silencer"].includes(privateByUid[player.id]?.role)
  ).length;

  // Neutral players still count as living opponents when checking Mafia parity.
  const nonMafiaAlive = living.length - mafiaAlive;

  if (mafiaAlive === 0) return "Town";
  if (mafiaAlive >= nonMafiaAlive) return "Mafia";

  return null;
}

async function revealEliminatedPlayer(uid) {
  const player = players.find(item => item.id === uid);
  if (!player) return;

  const roleReveal = room.settings?.revealRoles === false
    ? null
    : (privateByUid[uid]?.role || null);
  const eliminationMethod = room.phase === "voting" ? "vote" : room.phase === "night" ? "night" : "challenge";
  await updateDoc(playerRef(uid), {
    alive: false,
    ready: false,
    roleReveal,
    eliminationMethod,
    eliminatedRound: room.round,
    eliminatedPhase: room.phase
  });
  players = players.map(item => item.id === uid
    ? { ...item, alive: false, ready: false, roleReveal, eliminationMethod, eliminatedRound: room.round, eliminatedPhase: room.phase }
    : item);
}

async function clearActions() {
  const intentSnapshot = await getDocs(mafiaIntentsRef()).catch(() => null);
  await Promise.all([
    ...Object.keys(actionsByUid).map(uid => deleteDoc(actionRef(uid)).catch(() => {})),
    ...(intentSnapshot?.docs || []).map(item => deleteDoc(mafiaIntentRef(item.id)).catch(() => {}))
  ]);

  actionsByUid = {};
  mafiaIntentsByUid = {};
  myAction = null;
}

async function beginPhase(phase, seconds = phaseDuration(phase), round = room.round, extra = {}) {
  await clearActions();

  await updateDoc(roomRef(), {
    phase,
    round,
    discussionPaused: false,
    pausedSecondsRemaining: null,
    ...(phase === "discussion" ? { challengeNotice: null } : {}),
    ...(phase === "voting"
      ? { voteStage: "initial", tiedPlayerUids: [] }
      : { voteStage: null, tiedPlayerUids: [] }),
    endsAt: timestampAfter(seconds),
    ...extra,
    updatedAt: serverTimestamp()
  });
}

async function finishGame(winner, bountyHunterWinnerUids = []) {
  const finalResults = players.map(player => {
    const privateData = privateByUid[player.id] || {};
    const role = privateData.role || "Unknown";
    const alignment = alignmentForRole(role);
    const won = winner === "Jester"
      ? role === "Jester"
      : winner === "Bounty Hunter"
        ? role === "Bounty Hunter" && bountyHunterWinnerUids.includes(player.id)
        : winner === alignment && alignment !== "Neutral";
    return {
      uid: player.id,
      name: player.name || "Player",
      activeTitle: player.activeTitle || "",
      role,
      originalRole: privateData.roleStolen ? "Thief" : null,
      alignment,
      alive: player.alive !== false,
      eliminationMethod: player.eliminationMethod || null,
      eliminatedRound: player.eliminatedRound ?? null,
      eliminatedPhase: player.eliminatedPhase || null,
      unanimousVote: player.unanimousVote === true,
      fatalDiscovery: player.fatalDiscovery === true || privateData.fatalDiscovery === true,
      startingRole: privateData.startingRole || role,
      won
    };
  });

  await Promise.all(players.map(async player => {
    const result = finalResults.find(item => item.uid === player.id);
    await updateDoc(playerRef(player.id), {
      roleReveal: result?.role || "Unknown",
      originalRoleReveal: result?.originalRole || null
    });
  }));

  await updateDoc(roomRef(), {
    phase: "finished",
    winner,
    finalResults,
    bountyHunterWinnerUids,
    endsAt: null,
    updatedAt: serverTimestamp()
  });

  await clearActions();
  showNotice(winner === "Town" ? "The Town has won!" : winner === "Jester" ? "The Jester has won!" : winner === "Bounty Hunter" ? "The Bounty Hunter has claimed their target!" : "The Mafia has won!");
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
      const challenge = currentActions("discussion").find(action =>
        action.type === "challenge" && privateByUid[action.uid]?.role === "Knight" &&
        Boolean(privateByUid[action.targetUid]?.role) &&
        !privateByUid[action.uid]?.knightChallengeUsed &&
        players.some(player => player.id === action.uid && player.alive !== false) &&
        players.some(player => player.id === action.targetUid && player.alive !== false)
      );
      if (!challenge) {
        await beginPhase("voting", phaseDuration("voting"), round);
        return;
      }

      const remainingSeconds = secondsUntil(latestRoom.endsAt);
      await updateDoc(roomRef(), {
        discussionPaused: true,
        pausedSecondsRemaining: remainingSeconds,
        endsAt: null,
        updatedAt: serverTimestamp()
      });
      room = { ...latestRoom, discussionPaused: true, pausedSecondsRemaining: remainingSeconds, endsAt: null };

      const challengedRole = privateByUid[challenge.targetUid]?.role;
      const knightData = { ...privateByUid[challenge.uid], knightChallengeUsed: true };
      await setDoc(privateRef(challenge.uid), knightData);
      privateByUid[challenge.uid] = knightData;

      const challengeSucceeded = alignmentForRole(challengedRole) !== "Town";
      const eliminatedUid = challengeSucceeded ? challenge.targetUid : challenge.uid;
      await updateDoc(playerRef(eliminatedUid), {
        alive: false,
        ready: false,
        roleReveal: room.settings?.revealRoles === false ? null : (challengeSucceeded ? challengedRole : "Knight"),
        eliminationMethod: "challenge",
        eliminatedRound: round,
        eliminatedPhase: "discussion"
      });
      players = players.map(player => player.id === eliminatedUid
        ? { ...player, alive: false, roleReveal: room.settings?.revealRoles === false ? null : (challengeSucceeded ? challengedRole : "Knight"), eliminationMethod: "challenge", eliminatedRound: round, eliminatedPhase: "discussion" }
        : player);

      const revealChallengeRoles = room.settings?.revealRoles !== false;
      const challengeNotice = challengeSucceeded
        ? playerName(challenge.targetUid) + (revealChallengeRoles ? " was challenged and revealed as " + challengedRole + ". The Knight was correct." : " was challenged. The Knight was correct.")
        : (revealChallengeRoles ? playerName(challenge.targetUid) + " was revealed as Town." : "The Knight challenged a Town player.") + " The Knight has been eliminated; voting is skipped.";
      await updateDoc(roomRef(), { challengeNotice, updatedAt: serverTimestamp() });
      room = { ...room, challengeNotice };
      await clearActions();

      if (!challengeSucceeded) {
        const winner = await checkWinner();
        if (winner) {
          await finishGame(winner);
          return;
        }
        await beginPhase("night", phaseDuration("night"), round);
        return;
      }

      const winner = await checkWinner();
      if (winner) {
        await finishGame(winner);
        return;
      }
      if (remainingSeconds <= 0) {
        await beginPhase("voting", phaseDuration("voting"), round);
      } else {
        await updateDoc(roomRef(), {
          discussionPaused: false,
          pausedSecondsRemaining: null,
          endsAt: timestampAfter(remainingSeconds),
          updatedAt: serverTimestamp()
        });
      }
      return;
    }

    if (phase === "night") {
      const nightActions = currentActions("night");

      const mafiaVotes = nightActions.filter(action =>
        action.type === "kill" &&
        ["Mafia", "Silencer"].includes(privateByUid[action.uid]?.role) &&
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

      const silenceActions = nightActions.filter(action =>
        action.type === "silence" &&
        privateByUid[action.uid]?.role === "Silencer" &&
        players.some(player => player.id === action.uid && player.alive !== false) &&
        players.some(player => player.id === action.targetUid && player.alive !== false)
      );

      const detectiveActions = nightActions.filter(action =>
        action.type === "investigate" &&
        privateByUid[action.uid]?.role === "Detective" &&
        players.some(player => player.id === action.uid && player.alive !== false) &&
        players.some(player => player.id === action.targetUid && player.alive !== false)
      );

      const trackerActions = nightActions.filter(action =>
        action.type === "track" && privateByUid[action.uid]?.role === "Tracker" &&
        players.some(player => player.id === action.uid && player.alive !== false) &&
        players.some(player => player.id === action.targetUid && player.alive !== false)
      );

      const thiefActions = nightActions.filter(action =>
        ["steal", "stealRole"].includes(action.type) &&
        privateByUid[action.uid]?.role === "Thief" &&
        !privateByUid[action.uid]?.roleStolen &&
        players.some(player => player.id === action.uid && player.alive !== false)
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

      if (killedUid && protectedUids.has(killedUid)) {
        for (const action of doctorActions.filter(item => item.targetUid === killedUid)) {
          const doctorData = privateByUid[action.uid] || {};
          const savedUids = [...new Set([...(doctorData.clutchSavedUids || []), killedUid])];
          const updatedDoctor = { ...doctorData, clutchSavedUids: savedUids, clutchSaves: savedUids.length };
          await setDoc(privateRef(action.uid), updatedDoctor);
          privateByUid[action.uid] = updatedDoctor;
        }
      }

      const fatalDetectives = killedUid && !protectedUids.has(killedUid)
        ? detectiveActions.filter(action =>
            action.uid === killedUid && ["Mafia", "Silencer"].includes(privateByUid[action.targetUid]?.role)
          )
        : [];
      for (const action of fatalDetectives) {
        const detectiveData = { ...(privateByUid[action.uid] || {}), fatalDiscovery: true };
        await setDoc(privateRef(action.uid), detectiveData);
        privateByUid[action.uid] = detectiveData;
        await updateDoc(playerRef(action.uid), { fatalDiscovery: true });
        players = players.map(player => player.id === action.uid ? { ...player, fatalDiscovery: true } : player);
      }

      if (killedUid && !protectedUids.has(killedUid)) {
        await revealEliminatedPlayer(killedUid);
      }

      for (const action of detectiveActions) {
        const targetRole = privateByUid[action.targetUid]?.role;
        const result = ["Mafia", "Silencer"].includes(targetRole)
          ? `${playerName(action.targetUid)} is Mafia.`
          : `${playerName(action.targetUid)} is not Mafia.`;

        const detectiveData = {
          ...privateByUid[action.uid],
          investigationResult: result,
          ...(round === 1 && ["Mafia", "Silencer"].includes(targetRole) ? { sherlocksIntuition: true } : {})
        };
        await setDoc(privateRef(action.uid), detectiveData);
        privateByUid[action.uid] = detectiveData;
      }

      for (const action of trackerActions) {
        const visited = nightActions.some(item =>
          item.uid === action.targetUid &&
          ["kill", "silence", "protect", "investigate", "track", "steal", "stealRole"].includes(item.type)
        );
        const result = playerName(action.targetUid) + (visited
          ? " visited someone during the night."
          : " did not visit anyone during the night.");
        const updatedTracker = { ...privateByUid[action.uid], trackerResult: result };
        await setDoc(privateRef(action.uid), updatedTracker);
        privateByUid[action.uid] = updatedTracker;
      }

      const silencerActors = players.filter(player => player.alive !== false && privateByUid[player.id]?.role === "Silencer");
      for (const silencer of silencerActors.filter(player => !silenceActions.some(action => action.uid === player.id))) {
        const silencerData = privateByUid[silencer.id] || {};
        const resetSilencer = { ...silencerData, silenceStreakTargetUid: null, silenceStreakCount: 0, muzzled: false };
        await setDoc(privateRef(silencer.id), resetSilencer);
        privateByUid[silencer.id] = resetSilencer;
      }

      for (const action of silenceActions) {
        await setDoc(privateRef(action.targetUid), {
          ...(privateByUid[action.targetUid] || {}),
          silencedRound: round
        });
        const silencerData = privateByUid[action.uid] || {};
        const streak = silencerData.silenceStreakTargetUid === action.targetUid
          ? Number(silencerData.silenceStreakCount || 0) + 1
          : 1;
        const updatedSilencer = {
          ...silencerData,
          silenceStreakTargetUid: action.targetUid,
          silenceStreakCount: streak,
          muzzled: streak >= 3
        };
        await setDoc(privateRef(action.uid), updatedSilencer);
        privateByUid[action.uid] = updatedSilencer;
      }

      for (const action of thiefActions) {
        const thiefData = privateByUid[action.uid] || {};
        if (action.type === "steal") {
          const targetRole = privateByUid[action.targetUid]?.role;
          if (!targetRole) continue;
          const tokens = ["Mafia", "Silencer"].includes(targetRole)
            ? 2
            : ["Jester", "Thief"].includes(targetRole)
              ? 3
              : 1;
          const updated = { ...thiefData, thiefTokens: (thiefData.thiefTokens || 0) + tokens };
          await setDoc(privateRef(action.uid), updated);
          privateByUid[action.uid] = updated;
        } else if (
          action.type === "stealRole" &&
          (thiefData.thiefTokens || 0) >= 5 &&
          !thiefData.roleStolen &&
          players.some(player => player.id === action.targetUid && player.alive === false)
        ) {
          const inheritedRole = privateByUid[action.targetUid]?.role;
          if (!inheritedRole || inheritedRole === "Thief") continue;

          const updatedThief = {
            ...thiefData,
            role: inheritedRole,
            roleStolen: true,
            originalRole: "Thief",
            inheritedFromUid: action.targetUid,
            ...(inheritedRole === "Bounty Hunter"
              ? { bountyTargetUid: privateByUid[action.targetUid]?.bountyTargetUid || null }
              : {})
          };

          if (["Mafia", "Silencer"].includes(inheritedRole)) {
            const teammates = players.filter(player =>
              player.id !== action.uid && player.alive !== false &&
              ["Mafia", "Silencer"].includes(privateByUid[player.id]?.role)
            ).map(player => player.id);
            updatedThief.mafiaTeammates = teammates;
            for (const teammateUid of teammates) {
              const teammateData = privateByUid[teammateUid] || {};
              const updatedTeammate = {
                ...teammateData,
                mafiaTeammates: [...new Set([...(teammateData.mafiaTeammates || []), action.uid])]
              };
              await setDoc(privateRef(teammateUid), updatedTeammate);
              privateByUid[teammateUid] = updatedTeammate;
            }
          }

          await setDoc(privateRef(action.uid), updatedThief);
          privateByUid[action.uid] = updatedThief;
          showNotice("A Thief has permanently stolen a new role!");
        }
      }

      await beginPhase("discussion", phaseDuration("discussion"), round, {
        nightDeaths: killedUid && !protectedUids.has(killedUid)
          ? [{ uid: killedUid, name: playerName(killedUid) }]
          : []
      });
      return;
    }

    if (phase === "voting") {
      const votes = currentActions("voting").filter(action =>
        action.type === "vote" &&
        privateByUid[action.uid]?.silencedRound !== round &&
        players.some(player => player.id === action.uid && player.alive !== false) &&
        players.some(player => player.id === action.targetUid && player.alive !== false) &&
        (room.voteStage !== "tiebreaker" || (room.tiedPlayerUids || []).includes(action.targetUid))
      );

      const counts = {};
      votes.forEach(action => {
        const voterRole = privateByUid[action.uid]?.role;
        const weight = voterRole === "Mayor" ? 2 : 1;
        counts[action.targetUid] = (counts[action.targetUid] || 0) + weight;
      });

      let eliminatedUid = null;
      let topTargets = [];
      if (Object.keys(counts).length) {
        const highest = Math.max(...Object.values(counts));
        topTargets = Object.keys(counts).filter(uid => counts[uid] === highest);
      }

      if (room.voteStage !== "tiebreaker" && topTargets.length > 1) {
        for (const vote of votes) {
          const voterData = privateByUid[vote.uid] || {};
          const voteHistory = [...(voterData.voteHistory || []), { round, targetUid: vote.targetUid }];
          const updatedVoter = { ...voterData, voteHistory };
          await setDoc(privateRef(vote.uid), updatedVoter);
          privateByUid[vote.uid] = updatedVoter;
        }
        await clearActions();
        await updateDoc(roomRef(), {
          voteStage: "tiebreaker",
          tiedPlayerUids: topTargets,
          endsAt: timestampAfter(phaseDuration("voting")),
          updatedAt: serverTimestamp()
        });
        showNotice("The vote is tied! A tie-breaker vote has started.");
        return;
      }

      if (topTargets.length === 1) eliminatedUid = topTargets[0];

      const livingBeforeVote = alivePlayers();
      const unanimous = Boolean(
        eliminatedUid &&
        votes.length === livingBeforeVote.length - 1 &&
        votes.every(action => action.targetUid === eliminatedUid)
      );
      if (unanimous) {
        await updateDoc(playerRef(eliminatedUid), { unanimousVote: true });
        players = players.map(player => player.id === eliminatedUid
          ? { ...player, unanimousVote: true }
          : player);
      }

      const currentVoteByUid = new Map(votes.map(vote => [vote.uid, vote.targetUid]));
      const votersWithPendingHistory = players
        .filter(player => (privateByUid[player.id]?.voteHistory || []).some(item => item.round === round))
        .map(player => player.id);
      const votersToScore = new Set([...currentVoteByUid.keys(), ...votersWithPendingHistory]);

      for (const voterUid of votersToScore) {
        const voterData = privateByUid[voterUid] || {};
        const history = voterData.voteHistory || [];
        const thisRoundChoices = history.filter(item => item.round === round);
        const currentChoice = currentVoteByUid.get(voterUid);
        if (currentChoice) thisRoundChoices.push({ round, targetUid: currentChoice });
        const incorrect = thisRoundChoices.filter(item => !eliminatedUid || item.targetUid !== eliminatedUid).length;
        const updatedVoter = {
          ...voterData,
          incorrectVotes: Number(voterData.incorrectVotes || 0) + incorrect,
          voteHistory: history.filter(item => item.round !== round)
        };
        await setDoc(privateRef(voterUid), updatedVoter);
        privateByUid[voterUid] = updatedVoter;
      }

      if (eliminatedUid) {
        const winningHunters = players
          .filter(player => player.alive !== false && privateByUid[player.id]?.role === "Bounty Hunter" &&
            privateByUid[player.id]?.bountyTargetUid === eliminatedUid)
          .map(player => player.id);
        if (winningHunters.length) {
          await revealEliminatedPlayer(eliminatedUid);
          await finishGame("Bounty Hunter", winningHunters);
          return;
        }
      }

      if (eliminatedUid && privateByUid[eliminatedUid]?.role === "Jester") {
        await revealEliminatedPlayer(eliminatedUid);
        await finishGame("Jester");
        return;
      }

      if (eliminatedUid) await revealEliminatedPlayer(eliminatedUid);

      const winner = await checkWinner();
      if (winner) {
        await finishGame(winner);
        return;
      }

      await beginPhase("night", phaseDuration("night"), round + 1);
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
    const nextHost = remaining.length
      ? remaining[Math.floor(Math.random() * remaining.length)].id
      : null;

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

    const keepMatchRecords = room?.phase && room.phase !== "lobby";
    const cleanup = [deleteDoc(actionRef(uid, code)).catch(() => {})];
    if (!keepMatchRecords) {
      cleanup.push(
        deleteDoc(playerRef(uid, code)).catch(() => {}),
        deleteDoc(privateRef(uid, code)).catch(() => {})
      );
    }
    await Promise.all(cleanup);

    disconnectRoomListeners();
    localStorage.removeItem(activeRoomStorageKey(uid));

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
