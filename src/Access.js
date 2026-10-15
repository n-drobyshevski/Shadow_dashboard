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
 *     seconds, during which the group grants nothing (it is never treated as a membership);
 *   - a cache failure (read or write) only means a live GroupsApp check, never an access granted.
 * Removing a group from the access list applies at once (the cache is only read for listed groups).
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
  var GROUP_ERROR_CACHE_S = 120; // an unreadable group is retried after this delay (denies meanwhile)
  var MAX_GROUP_CHECKS = 30;     // GroupsApp calls per membership test at most (wide nested trees)

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

  function groupKey_(group, email) {
    return 'grp:' + group + '|' + email;
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
   * Values: 'm:<ms of the last live check>' member, 'n' not a member, 'e' group not readable (denies).
   */
  function cachedAnswer_(value, now) {
    if (value === 'n' || value === 'e') return false;
    var m = /^m:(\d{1,15})$/.exec(typeof value === 'string' ? value : '');
    if (!m) return null;
    var age = now - Number(m[1]);
    return age >= 0 && age < GROUP_MAX_AGE_S * 1000 ? true : null;
  }

  /**
   * Is `email` a member of `group` (normalised), using the values `cached` read beforehand
   * (cachedGroups_) and checking live on a miss. A "member" hit renews its GROUP_CACHE_S lifetime, never
   * beyond GROUP_MAX_AGE_S after its live check. Errors (group gone, members hidden from the deployer,
   * quota) count as "not a member", are logged, never thrown, and are cached GROUP_ERROR_CACHE_S seconds.
   */
  function memberCached_(group, email, cache, cached) {
    var key = groupKey_(group, email);
    var now = Date.now();
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
      console.warn('Access: group ' + group + ' not readable (' + (e && e.message) + ')');
      cachePut_(cache, key, 'e', GROUP_ERROR_CACHE_S);
      return false;
    }
    cachePut_(cache, key, member ? 'm:' + now : 'n', GROUP_CACHE_S);
    return member;
  }

  /** Is `email` a member of `groupEmail` (directly or through sub-groups)? Cached, see memberCached_. */
  function isGroupMember(groupEmail, email) {
    var group = normEmail(groupEmail);
    var cache = cache_();
    return memberCached_(group, email, cache, cachedGroups_(cache, [groupKey_(group, email)]));
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
   * the groups (only checked when they can raise the role) and the domain role.
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
    var keys = [];
    groups.forEach(function (g) {
      var key = groupKey_(g.email, email);
      if (keys.indexOf(key) < 0) keys.push(key);
    });
    var cached = cachedGroups_(cache, keys);
    for (var i = 0; i < groups.length; i++) {
      if (memberCached_(groups[i].email, email, cache, cached)) return groups[i].role;
    }
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
    if (!user.email) {
      throw Core.makeError('FORBIDDEN', 'Identité Google non transmise. Ouvrez l’application avec un compte du ' +
        'même domaine Google Workspace que son propriétaire.');
    }
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
    checkEmail: checkEmail,
    checkRole: checkRole,
    checkGroup: checkGroup,
    isGroupMember: isGroupMember,
    cacheGet: cacheGet,
    cachePut: cachePut,
    GROUP_DEPTH: GROUP_DEPTH,
    GROUP_CACHE_S: GROUP_CACHE_S,
    GROUP_MAX_AGE_S: GROUP_MAX_AGE_S,
    GROUP_ERROR_CACHE_S: GROUP_ERROR_CACHE_S
  };
})();
