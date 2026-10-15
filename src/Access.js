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
 * the app. Accounts that are not listed get `domainRole` ('none' by default, or 'lecteur').
 *
 * Load-order safe: the IIFE only defines values and functions; GAS services are touched lazily.
 */
var Access = (function () {
  var ROLES = ['admin', 'lecteur'];
  var DOMAIN_ROLES = ['none', 'lecteur'];
  var RANK = { lecteur: 1, admin: 2 };
  var EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

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

  /** Role of `email` for the given access list ('' = no access). */
  function roleOf(email, owner, access) {
    if (!email) return '';
    if (owner && email === owner) return 'admin';
    var hit = (access.users || []).filter(function (u) { return normEmail(u.email) === email; })[0];
    if (hit && RANK[hit.role]) return hit.role;
    return access.domainRole === 'lecteur' ? 'lecteur' : '';
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
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
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
    checkRole: checkRole
  };
})();
