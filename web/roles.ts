/** Workspace role names shown to people. The accountant "Księgowa" (migration 266) is a viewer session with
 * `accountant: true`; lists from the server (team, invitations, workspaces) already carry role 'accountant'. */
export const ROLE_LABELS: Readonly<Record<string, string>> = {
  admin: 'Administrator',
  operator: 'Magazynier',
  viewer: 'Tylko odczyt',
  accountant: 'Księgowa',
};

export interface RoleHolder {
  role: string;
  accountant?: boolean;
  /** "Automatyzacje: edycja" (267): an operator with the grant; the server sends it on the session user. */
  automation_editor?: boolean;
}

/** The accountant: a viewer with the grant. Reads like a viewer; edits only payments. */
export function isAccountant(user: RoleHolder | null | undefined): boolean {
  return user?.role === 'viewer' && user.accountant === true;
}

export function roleLabel(user: RoleHolder): string {
  return ROLE_LABELS[isAccountant(user) ? 'accountant' : user.role] ?? user.role;
}

/** Who may create and change automation rules: the administrator, or an operator with "Automatyzacje: edycja". */
export function canEditAutomations(user: RoleHolder | null | undefined): boolean {
  return user?.role === 'admin' || (user?.role === 'operator' && user.automation_editor === true);
}
