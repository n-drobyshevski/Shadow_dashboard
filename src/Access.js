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
 * Group memberships are cached GROUP_CACHE_S seconds (CacheService), so a membership change in Google
 * applies within that delay; removing a group from the list applies at once.
 *
 * Load-order safe: the IIFE only defines values and functions; GAS services are touched lazily.
 */
var Access = (function () {
  var ROLES = ['admin', 'lecteur'];
  var DOMAIN_ROLES = ['none', 'lecteur'];
  var RANK = { lecteur: 1, admin: 2 };
  var GROUP_DEPTH = 3;       // the group itself + 2 levels of sub-groups
  var GROUP_CACHE_S = 600;   // membership cache (seconds)
  var MAX_GROUP_CHECKS = 30; // GroupsApp calls per membership test at most (wide nested trees)

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
   * Is `email` a member of `groupEmail` (directly or through sub-groups)? Errors (group gone, members
   * hidden from the deployer, quota) count as "not a member" and are logged, never thrown, and are not
   * cached. Results are cached GROUP_CACHE_S seconds.
   */
  function isGroupMember(groupEmail, email) {
    var group = normEmail(groupEmail);
    var key = 'grp:' + group + '|' + email;
    var cache = cache_();
    var cached = cache ? cache.get(key) : null;
    if (cached === '1' || cached === '0') return cached === '1';
    var budget = { left: MAX_GROUP_CHECKS };
    var member;
    try {
      member = memberOf_(GroupsApp.getGroupByEmail(group), email, GROUP_DEPTH, {}, budget);
    } catch (e) {
      console.warn('Access: group ' + group + ' not readable (' + (e && e.message) + ')');
      return false;
    }
    if (cache) {
      try { cache.put(key, member ? '1' : '0', GROUP_CACHE_S); } catch (e) { /* cache full: ignore */ }
    }
    return member;
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
    ['admin', 'lecteur'].forEach(function (groupRole) {
      if (role && RANK[role] >= RANK[groupRole]) return;
      var groups = (access.groups || []).filter(function (g) { return g.role === groupRole; });
      for (var i = 0; i < groups.length; i++) {
        if (isGroupMember(groups[i].email, email)) { role = groupRole; return; }
      }
    });
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
    GROUP_DEPTH: GROUP_DEPTH,
    GROUP_CACHE_S: GROUP_CACHE_S
  };
})();
