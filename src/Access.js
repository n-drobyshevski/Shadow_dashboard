/**
 * Access — who is calling, with which role (docs/API.md §4, « Accès »).
 *
 * The web app runs as the deployer (executeAs USER_DEPLOYING) with access DOMAIN: the data and
 * source spreadsheets stay private to the deployer and the app is the only way in. The caller's
 * identity is Session.getActiveUser(), which Google fills in for accounts of the deployer's Google
 * Workspace; for anyone else it is '' and the call is refused.
 *
 * Roles: 'admin' (everything, incl. Paramètres) and 'lecteur' (read only). The deployer
 * (Session.getEffectiveUser()) is always admin and is not stored in the list, so nobody can lock
 * the app. A caller's role is the highest of: their own entry, the Google Groups they belong to
 * (GroupsApp, sub-groups up to GROUP_DEPTH levels, run as the deployer who must be able to see the
 * members), and `domainRole` ('none' by default, or 'lecteur') for any account of the domain.
 * Group membership cache (CacheService, one key per group and account, read for every group a call
 * may need in ONE getAll):
 *   - "member": sliding GROUP_CACHE_S seconds (renewed on every hit) but re-verified with GroupsApp at
 *     least every GROUP_MAX_AGE_S seconds (the value carries the time of the last live check), so
 *     removing someone from a group in Google applies within 1 h even for an account in daily use;
 *   - "not a member": fixed GROUP_CACHE_S seconds, so adding someone applies within 10 min;
 *   - group not readable (deleted, members hidden from the deployer, quota): fixed GROUP_ERROR_CACHE_S
 *     seconds, during which the group grants nothing, except to a confirmed member (stale on error, below);
 *   - a cache failure (read or write) only means a live GroupsApp check, never an access granted.
 * Removing a group from the access list applies at once (the cache is only read for listed groups).
 * Stale on error: every live check that confirms a membership also writes a long-lived "confirmed"
 * entry (GROUP_OK_CACHE_S, 6 h after that check). When GroupsApp then fails for that group (any error:
 * daily "Groups read" quota used up, group deleted, members hidden), the call is answered from it instead
 * of denying, and the error is logged: a quota used up by others does not lock out every group-based
 * user. It only ever answers on an error, and a live "not a member" removes it, so a removal from the
 * group still applies within 1 h; only while GroupsApp fails can a removed member keep access, for at
 * most 6 h after their last confirmed membership.
 * No role at all: an account that gets nothing from its entry, the domain role or any listed group
 * (every group answered "not a member", no error) is remembered GROUP_CACHE_S seconds in ONE entry keyed
 * by the list of groups (any change to it is a new key), read in the same getAll as the groups: a refused
 * caller does not walk every group again on each call.
 *
 * Throttle (throttle, called by apiWrap_ and doGet before anything else): at most THROTTLE_PER_MIN units
 * per account and per minute, one per call and HEAVY_WEIGHT for the full-history reads (THROTTLE_WEIGHTS),
 * and at most THROTTLE_IN_FLIGHT calls of the account running at once (the start time of each running call
 * is kept, removed by the release function the caller runs in `finally`; an entry older than
 * IN_FLIGHT_MAX_S, left by an execution killed before its `finally`, no longer counts), counted in the
 * script cache, then BUSY. The counters are read and written under the user lock (LockService.getUserLock,
 * never the script lock that Store's writes hold for long), so concurrent calls of one account each
 * count. It runs before the Script Properties are read, so an account, with or without a role, can neither
 * spend the deployer's daily quotas without limit nor keep many executions busy at once. A cache failure
 * lets the call through; a lock not obtained within THROTTLE_LOCK_MS counts without it (best effort).
 *
 * Load-order safe: the IIFE only defines values and functions; GAS services are touched lazily.
 */
var Access = (function () {
  var ROLES = ['admin', 'lecteur'];
  var DOMAIN_ROLES = ['none', 'lecteur'];
  var RANK = { lecteur: 1, admin: 2 };
  var GROUP_DEPTH = 3;           // the group itself + 2 levels of sub-groups
  var GROUP_CACHE_S = 600;       // membership cache (seconds; sliding for "member")
  var GROUP_MAX_AGE_S = 3600;    // a cached "member" is re-verified at least this often (seconds)
  var GROUP_ERROR_CACHE_S = 120; // an unreadable group is retried after this delay (denies meanwhile, but stale on error)
  var MAX_GROUP_CHECKS = 30;     // GroupsApp calls per membership test at most (wide nested trees)
  var GROUP_OK_CACHE_S = 21600;  // a confirmed membership answers for GroupsApp errors this long (6 h, cache max)
  var THROTTLE_PER_MIN = 120;    // units per account and per minute (one per call, see THROTTLE_WEIGHTS)
  var HEAVY_WEIGHT = 5;          // units of a full-history read
  var THROTTLE_WEIGHTS = { api_getTimeline: HEAVY_WEIGHT, api_getDiff: HEAVY_WEIGHT, api_getImportLog: HEAVY_WEIGHT };
  var THROTTLE_IN_FLIGHT = 6;    // calls of one account running at once at most
  var IN_FLIGHT_MAX_S = 360;     // a running call older than this (the 6 min execution limit) no longer counts
  var THROTTLE_LOCK_MS = 3000;   // wait for the lock around the counters
  var MAX_KEY = 240;             // CacheService keys are limited to 250 characters

  function normEmail(v) {
    return typeof v === 'string' ? v.trim().toLowerCase() : '';
  }

  function sessionEmail_(user) {
    try { return normEmail(user && user.getEmail ? user.getEmail() : ''); } catch (e) { return ''; }
  }

  function ownerEmail() {
    return sessionEmail_(Session.getEffectiveUser());
  }

  function activeEmail() {
    return sessionEmail_(Session.getActiveUser());
  }

  function cache_() {
    try { return CacheService.getScriptCache(); } catch (e) { return null; }
  }

  /**
   * Script cache for the other modules (this file owns CacheService): the value of `key`, or null when
   * absent, expired or when the cache fails (never throws).
   */
  function cacheGet(key) {
    var cache = cache_();
    if (!cache) return null;
    try { return cache.get(key); } catch (e) { return null; }
  }

  /** Best-effort put (ttlS seconds); a full or unavailable cache is ignored. */
  function cachePut(key, value, ttlS) {
    cachePut_(cache_(), key, value, ttlS);
  }

  /** 32-bit FNV-1a of `s`, base 36: short, stable cache keys (not a security measure). */
  function hash_(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  /** `key` as is when CacheService accepts it, else its start and a hash of the whole (very long addresses). */
  function cacheKey_(key) {
    return key.length <= MAX_KEY ? key : key.slice(0, MAX_KEY - 10) + '#' + hash_(key);
  }

  function groupKey_(group, email) {
    return cacheKey_('grp:' + group + '|' + email);
  }

  /** Long-lived entry written when a live check confirms the membership: '<ms of that check>'. */
  function groupOkKey_(group, email) {
    return cacheKey_('grpok:' + group + '|' + email);
  }

  /** "No role" entry of `email` for this list of groups: any change to the groups or their roles is a new key. */
  function noRoleKey_(groups, email) {
    var sig = (groups || []).map(function (g) { return normEmail(g.email) + '=' + g.role; }).sort().join(',');
    return cacheKey_('nr:' + hash_(sig) + '|' + email);
  }

  function noIdentity_() {
    return Core.makeError('FORBIDDEN', 'Identité Google non transmise. Ouvrez l’application avec un compte du ' +
      'même domaine Google Workspace que son propriétaire.');
  }

  function noop_() {}

  function busy_(message) {
    var err = Core.makeError('BUSY', message);
    err.throttled = true;
    return err;
  }

  /** fn() under the user lock (THROTTLE_LOCK_MS wait); without it when it cannot be had (best effort). */
  function withCounterLock_(fn) {
    var lock = null;
    try {
      lock = LockService.getUserLock();
      if (!lock.tryLock(THROTTLE_LOCK_MS)) lock = null;
    } catch (e) {
      lock = null;
    }
    if (!lock) console.warn('Access: throttle lock not obtained, counted without it');
    try {
      return fn();
    } finally {
      if (lock) {
        try { lock.releaseLock(); } catch (e) { /* released when the execution ends */ }
      }
    }
  }

  /** Start times (ms) of an account's running calls from a cached value; [] for anything malformed. */
  function inFlight_(value) {
    var list;
    try { list = JSON.parse(typeof value === 'string' ? value : '[]'); } catch (e) { list = []; }
    return Array.isArray(list) ? list.filter(function (v) { return typeof v === 'number' && isFinite(v); }) : [];
  }

  /**
   * Per-account limits, called by apiWrap_ (and doGet) before the Script Properties are read: FORBIDDEN
   * without an identity (as requireRole would); BUSY when the account has used THROTTLE_PER_MIN units in
   * the current minute (`name` costs THROTTLE_WEIGHTS[name], else 1) or already has THROTTLE_IN_FLIGHT calls
   * running. The deployer is not limited (their own calls spend their own quotas, and they keep a way in).
   * Costs one cache getAll and, when the call goes through, one putAll (a refused call writes nothing).
   * Returns the release function the caller must run when the call ends (in `finally`): it removes the
   * call from the running ones (one get and one put). A cache failure lets the call through (fail open).
   * @return {function()} release
   */
  function throttle(name) {
    var email = activeEmail();
    if (!email) throw noIdentity_();
    if (email === ownerEmail()) return noop_;
    var cache = cache_();
    if (!cache) return noop_;
    var started = Date.now();
    var rateKey = cacheKey_('rl:' + Math.floor(started / 60000) + '|' + email);
    var flightKey = cacheKey_('if:' + email);
    var counted = withCounterLock_(function () {
      var got;
      try {
        got = cache.getAll([rateKey, flightKey]) || {};
      } catch (e) {
        console.warn('Access: throttle cache not readable (' + (e && e.message) + '), call let through');
        return false;
      }
      var used = Number(got[rateKey]) || 0;
      var cost = THROTTLE_WEIGHTS[name] || 1;
      if (used + cost > THROTTLE_PER_MIN) throw busy_('Trop de requêtes. Réessayez dans une minute.');
      var running = inFlight_(got[flightKey]).filter(function (t) {
        return t <= started && started - t < IN_FLIGHT_MAX_S * 1000;
      });
      if (running.length >= THROTTLE_IN_FLIGHT) {
        throw busy_('Trop de requêtes en cours. Réessayez dans quelques instants.');
      }
      running.push(started);
      var values = {};
      values[rateKey] = String(used + cost);
      values[flightKey] = JSON.stringify(running);
      try { cache.putAll(values, IN_FLIGHT_MAX_S); } catch (e) { return false; /* not stored: nothing to release */ }
      return true;
    });
    if (!counted) return noop_;
    return function release() {
      withCounterLock_(function () {
        var running;
        try { running = inFlight_(cache.get(flightKey)); } catch (e) { return; /* the entry expires on its own */ }
        var i = running.indexOf(started);
        if (i < 0) return;
        running.splice(i, 1);
        cachePut_(cache, flightKey, JSON.stringify(running), IN_FLIGHT_MAX_S);
      });
    };
  }

  /**
   * Cached values of `keys` read in ONE getAll. {} when there is no cache or it fails: every group is
   * then checked live (a cache failure never grants anything).
   */
  function cachedGroups_(cache, keys) {
    if (!cache || !keys.length) return {};
    try {
      return cache.getAll(keys) || {};
    } catch (e) {
      console.warn('Access: group cache not readable (' + (e && e.message) + '), checking live');
      return {};
    }
  }

  function cachePut_(cache, key, value, ttl) {
    if (!cache) return;
    try { cache.put(key, value, ttl); } catch (e) { /* cache full or unavailable: checked live next time */ }
  }

  /**
   * Answer carried by a cached value at `now` (ms): true / false, or null when it cannot be used (absent,
   * unknown format such as an older version's value, or a "member" last verified GROUP_MAX_AGE_S ago or
   * more, or in the future): the group is then checked live.
   * Values: 'm:<ms of the last live check>' member, 'n' not a member, 'e' group not readable (denies;
   * memberCached_ answers it from the "confirmed" entry first).
   */
  function cachedAnswer_(value, now) {
    if (value === 'n' || value === 'e') return false;
    var m = /^m:(\d{1,15})$/.exec(typeof value === 'string' ? value : '');
    if (!m) return null;
    var age = now - Number(m[1]);
    return age >= 0 && age < GROUP_MAX_AGE_S * 1000 ? true : null;
  }

  /** True when a "confirmed" value ('<ms of a live check>') is usable at `now`: less than GROUP_OK_CACHE_S old. */
  function confirmed_(value, now) {
    if (!/^\d{1,15}$/.test(typeof value === 'string' ? value : '')) return false;
    var age = now - Number(value);
    return age >= 0 && age < GROUP_OK_CACHE_S * 1000;
  }

  /** Answer for a group that cannot be read: true from a confirmed membership, else false (and info.uncertain). */
  function staleAnswer_(confirmedValue, now, info) {
    if (confirmed_(confirmedValue, now)) return true;
    if (info) info.uncertain = true;
    return false;
  }

  /**
   * Is `email` a member of `group` (normalised), using the values `cached` read beforehand
   * (cachedGroups_: the group's entry and its "confirmed" entry) and checking live on a miss. A "member"
   * hit renews its GROUP_CACHE_S lifetime, never beyond GROUP_MAX_AGE_S after its live check. A live
   * "member" also writes the "confirmed" entry (GROUP_OK_CACHE_S), a live "not a member" removes it.
   * Errors (group gone, members hidden from the deployer, quota) are logged, never thrown, and cached
   * GROUP_ERROR_CACHE_S seconds ('e'); they are answered from the "confirmed" entry when there is one
   * (stale on error), else count as "not a member" and set `info.uncertain` (no "no role" entry then).
   */
  function memberCached_(group, email, cache, cached, info) {
    var key = groupKey_(group, email);
    var okKey = groupOkKey_(group, email);
    var now = Date.now();
    if (cached[key] === 'e') return staleAnswer_(cached[okKey], now, info);
    var hit = cachedAnswer_(cached[key], now);
    if (hit === true) {
      var left = Math.ceil((Number(cached[key].slice(2)) + GROUP_MAX_AGE_S * 1000 - now) / 1000);
      cachePut_(cache, key, cached[key], Math.max(1, Math.min(GROUP_CACHE_S, left)));
    }
    if (hit !== null) return hit;
    var budget = { left: MAX_GROUP_CHECKS };
    var member;
    try {
      member = memberOf_(GroupsApp.getGroupByEmail(group), email, GROUP_DEPTH, {}, budget);
    } catch (e) {
      console.warn('Access: group ' + group + ' not readable (' + (e && e.message) + ')' +
        (confirmed_(cached[okKey], now) ? ', answered from the last confirmed membership' : ''));
      cachePut_(cache, key, 'e', GROUP_ERROR_CACHE_S);
      return staleAnswer_(cached[okKey], now, info);
    }
    cachePut_(cache, key, member ? 'm:' + now : 'n', GROUP_CACHE_S);
    if (member) cachePut_(cache, okKey, String(now), GROUP_OK_CACHE_S);
    else if (typeof cached[okKey] === 'string') cacheRemove_(cache, okKey);
    return member;
  }

  function cacheRemove_(cache, key) {
    if (!cache) return;
    try { cache.remove(key); } catch (e) { /* cache unavailable: the entry expires on its own */ }
  }

  /** Is `email` a member of `groupEmail` (directly or through sub-groups)? Cached, see memberCached_. */
  function isGroupMember(groupEmail, email) {
    var group = normEmail(groupEmail);
    var cache = cache_();
    return memberCached_(group, email, cache, cachedGroups_(cache, [groupKey_(group, email), groupOkKey_(group, email)]));
  }

  function memberOf_(group, email, depth, seen, budget) {
    var id = normEmail(group.getEmail());
    if (seen[id] || budget.left <= 0) return false;
    seen[id] = true;
    budget.left--;
    if (group.hasUser(email)) return true;
    if (depth <= 1) return false;
    var children = group.getGroups() || [];
    for (var i = 0; i < children.length; i++) {
      if (memberOf_(children[i], email, depth - 1, seen, budget)) return true;
    }
    return false;
  }

  /**
   * Role of `email` for the given access list ('' = no access): the highest of the explicit entry,
   * the groups (only checked when they can raise the role) and the domain role. Without an entry or a
   * domain role, the "no role" entry is read in the same getAll as the groups: on a hit no group is
   * checked; it is written when every group answered "not a member" without an error.
   */
  function roleOf(email, owner, access) {
    if (!email) return '';
    if (owner && email === owner) return 'admin';
    var hit = (access.users || []).filter(function (u) { return normEmail(u.email) === email; })[0];
    var role = hit && RANK[hit.role] ? hit.role : '';
    if (role !== 'admin' && access.domainRole === 'lecteur') role = 'lecteur';
    // Groups whose role is above the current one, best role first; their cache entries in one read.
    var groups = [];
    ['admin', 'lecteur'].forEach(function (groupRole) {
      if (role && RANK[role] >= RANK[groupRole]) return;
      (access.groups || []).forEach(function (g) {
        if (g.role === groupRole) groups.push({ email: normEmail(g.email), role: groupRole });
      });
    });
    if (!groups.length) return role;
    var cache = cache_();
    var noRole = role ? '' : noRoleKey_(access.groups, email);
    var keys = noRole ? [noRole] : [];
    groups.forEach(function (g) {
      [groupKey_(g.email, email), groupOkKey_(g.email, email)].forEach(function (key) {
        if (keys.indexOf(key) < 0) keys.push(key);
      });
    });
    var cached = cachedGroups_(cache, keys);
    if (noRole && cached[noRole] === '1') return '';
    var info = { uncertain: false };
    for (var i = 0; i < groups.length; i++) {
      if (memberCached_(groups[i].email, email, cache, cached, info)) return groups[i].role;
    }
    if (noRole && !info.uncertain) cachePut_(cache, noRole, '1', GROUP_CACHE_S);
    return role;
  }

  /**
   * Validated group address or VALIDATION: the group must exist and its members must be visible to
   * the deployer (the app checks memberships with the deployer's account).
   */
  function checkGroup(v) {
    var email = checkEmail(v);
    try {
      var g = GroupsApp.getGroupByEmail(email);
      g.hasUser(ownerEmail() || email);
    } catch (e) {
      throw Core.makeError('VALIDATION', 'Groupe introuvable ou membres non visibles pour le propriétaire du ' +
        'déploiement : ' + email + '.');
    }
    return email;
  }

  /** @return {{email: string, role: string, isOwner: boolean, owner: string}} */
  function currentUser(access) {
    var email = activeEmail();
    var owner = ownerEmail();
    var list = access || Config.get().access;
    return { email: email, role: roleOf(email, owner, list), isOwner: !!email && email === owner, owner: owner };
  }

  /**
   * Throws FORBIDDEN unless the caller has at least `minRole` ('lecteur' | 'admin').
   * @return {{email: string, role: string, isOwner: boolean, owner: string}} the caller
   */
  function requireRole(minRole, access) {
    var user = currentUser(access);
    if (!user.email) throw noIdentity_();
    if (!user.role) {
      throw Core.makeError('FORBIDDEN', 'Accès refusé pour ' + user.email + '. Demandez l’accès à un administrateur.');
    }
    if (RANK[user.role] < RANK[minRole || 'lecteur']) {
      throw Core.makeError('FORBIDDEN', 'Action réservée aux administrateurs.');
    }
    return user;
  }

  /** Validated, normalised email or VALIDATION. */
  function checkEmail(v) {
    var email = normEmail(v);
    if (!Core.isEmail(email)) {
      throw Core.makeError('VALIDATION', 'Adresse e-mail invalide : « ' + Core.str(v) + ' ».');
    }
    return email;
  }

  function checkRole(v, allowed) {
    var list = allowed || ROLES;
    if (list.indexOf(v) < 0) {
      throw Core.makeError('VALIDATION', 'Rôle invalide : « ' + Core.str(v) + ' ».');
    }
    return v;
  }

  return {
    ROLES: ROLES,
    DOMAIN_ROLES: DOMAIN_ROLES,
    normEmail: normEmail,
    ownerEmail: ownerEmail,
    activeEmail: activeEmail,
    roleOf: roleOf,
    currentUser: currentUser,
    requireRole: requireRole,
    throttle: throttle,
    checkEmail: checkEmail,
    checkRole: checkRole,
    checkGroup: checkGroup,
    isGroupMember: isGroupMember,
    cacheGet: cacheGet,
    cachePut: cachePut,
    GROUP_DEPTH: GROUP_DEPTH,
    GROUP_CACHE_S: GROUP_CACHE_S,
    GROUP_MAX_AGE_S: GROUP_MAX_AGE_S,
    GROUP_ERROR_CACHE_S: GROUP_ERROR_CACHE_S,
    GROUP_OK_CACHE_S: GROUP_OK_CACHE_S,
    THROTTLE_PER_MIN: THROTTLE_PER_MIN,
    THROTTLE_IN_FLIGHT: THROTTLE_IN_FLIGHT,
    THROTTLE_WEIGHTS: THROTTLE_WEIGHTS
  };
})();
