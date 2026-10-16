// Access: who is calling and with which role ('admin' or 'lecteur').
// The app runs as the deployer, so the data stays private to them. Session.getActiveUser() is only
// filled in for accounts of the deployer's Workspace domain; anyone else gets '' and is refused.
// The deployer is always admin and is never stored in the list, so nobody can lock the app.
var Access = (function () {
  var ROLES = ['admin', 'lecteur'];
  var DOMAIN_ROLES = ['none', 'lecteur'];
  var RANK = { lecteur: 1, admin: 2 };
  var GROUP_DEPTH = 3;           // the group itself plus 2 levels of sub-groups
  var GROUP_CACHE_S = 600;
  var GROUP_MAX_AGE_S = 3600;    // a cached "member" is re-verified at least this often
  var GROUP_ERROR_CACHE_S = 120;
  var MAX_GROUP_CHECKS = 30;     // caps GroupsApp calls on wide nested trees
  var GROUP_OK_CACHE_S = 21600;  // 6 h, the CacheService maximum
  var THROTTLE_PER_MIN = 120;
  var HEAVY_WEIGHT = 5;          // cost of a full-history read
  var THROTTLE_WEIGHTS = { api_getTimeline: HEAVY_WEIGHT, api_getDiff: HEAVY_WEIGHT, api_getImportLog: HEAVY_WEIGHT };
  var THROTTLE_IN_FLIGHT = 10;   // a boot sends about 5 calls, so this allows two tabs
  var IN_FLIGHT_MAX_S = 360;     // the 6 min execution limit
  var THROTTLE_LOCK_MS = 3000;
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

  // Other modules reach CacheService only through cacheGet/cachePut. Neither throws.
  function cacheGet(key) {
    var cache = cache_();
    if (!cache) return null;
    try { return cache.get(key); } catch (e) { return null; }
  }

  function cachePut(key, value, ttlS) {
    cachePut_(cache_(), key, value, ttlS);
  }

  // FNV-1a, for short stable cache keys only (not a security measure).
  function hash_(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  function cacheKey_(key) {
    return key.length <= MAX_KEY ? key : key.slice(0, MAX_KEY - 10) + '#' + hash_(key);
  }

  function groupKey_(group, email) {
    return cacheKey_('grp:' + group + '|' + email);
  }

  function groupOkKey_(group, email) {
    return cacheKey_('grpok:' + group + '|' + email);
  }

  // Keyed by the group list, so any change to the groups or their roles invalidates it.
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

  // The user lock, not the script lock that Store's writes hold for long. Runs without it on timeout.
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

  function inFlight_(value) {
    var list;
    try { list = JSON.parse(typeof value === 'string' ? value : '[]'); } catch (e) { list = []; }
    return Array.isArray(list) ? list.filter(function (v) { return typeof v === 'number' && isFinite(v); }) : [];
  }

  /**
   * Per-account rate and concurrency limit, run before the Script Properties are read so no account can
   * burn the deployer's quotas. Throws FORBIDDEN or BUSY. The caller must run the returned release
   * function in `finally`. A cache failure lets the call through.
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
      try { cache.putAll(values, IN_FLIGHT_MAX_S); } catch (e) { return false; }
      return true;
    });
    if (!counted) return noop_;
    return function release() {
      withCounterLock_(function () {
        var running;
        try { running = inFlight_(cache.get(flightKey)); } catch (e) { return; }
        var i = running.indexOf(started);
        if (i < 0) return;
        running.splice(i, 1);
        cachePut_(cache, flightKey, JSON.stringify(running), IN_FLIGHT_MAX_S);
      });
    };
  }

  // A cache failure returns {} so every group is checked live, never granted.
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
    try { cache.put(key, value, ttl); } catch (e) { /* checked live next time */ }
  }

  // Values: 'm:<ms of last live check>' member, 'n' not a member, 'e' unreadable. null means check live.
  function cachedAnswer_(value, now) {
    if (value === 'n' || value === 'e') return false;
    var m = /^m:(\d{1,15})$/.exec(typeof value === 'string' ? value : '');
    if (!m) return null;
    var age = now - Number(m[1]);
    return age >= 0 && age < GROUP_MAX_AGE_S * 1000 ? true : null;
  }

  function confirmed_(value, now) {
    if (!/^\d{1,15}$/.test(typeof value === 'string' ? value : '')) return false;
    var age = now - Number(value);
    return age >= 0 && age < GROUP_OK_CACHE_S * 1000;
  }

  function staleAnswer_(confirmedValue, now, info) {
    if (confirmed_(confirmedValue, now)) return true;
    if (info) info.uncertain = true;
    return false;
  }

  /**
   * A "member" hit slides but is re-verified hourly, so a removal from the group applies within 1 h.
   * When GroupsApp fails (quota, deleted group, hidden members), a membership confirmed in the last 6 h
   * still answers, so a quota used up by others does not lock out group-based users.
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
    try { cache.remove(key); } catch (e) { /* expires on its own */ }
  }

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
   * Highest of the explicit entry, the domain role and the groups. '' means no access. A refused caller
   * is remembered for GROUP_CACHE_S so it does not walk every group on each call.
   */
  function roleOf(email, owner, access) {
    if (!email) return '';
    if (owner && email === owner) return 'admin';
    var hit = (access.users || []).filter(function (u) { return normEmail(u.email) === email; })[0];
    var role = hit && RANK[hit.role] ? hit.role : '';
    if (role !== 'admin' && access.domainRole === 'lecteur') role = 'lecteur';
    // Only groups that could raise the role, best role first.
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

  // Memberships are checked as the deployer, so they must be able to see the group's members.
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

  function currentUser(access) {
    var email = activeEmail();
    var owner = ownerEmail();
    var list = access || Config.get().access;
    return { email: email, role: roleOf(email, owner, list), isOwner: !!email && email === owner, owner: owner };
  }

  /** Throws FORBIDDEN unless the caller has at least `minRole`. Returns the currentUser() object. */
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
