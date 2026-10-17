#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const READ_ONLY_PERMISSIONS = new Set([
  'incidents:read',
  'knowledge:read',
  'graph:read',
  'remediations:read',
  'evaluations:read',
]);
const REQUIRED_BASELINE_PERMISSIONS = ['incidents:read', 'knowledge:read', 'graph:read'];
const MANAGEMENT_SCOPES = [
  'read:users',
  'read:organizations',
  'read:roles',
  'read:organization_member_roles',
  'create:organization_members',
  'create:organization_member_roles',
];
const REQUEST_TIMEOUT_MS = 8_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type JsonRecord = Record<string, unknown>;
type FetchLike = typeof fetch;

export interface OnboardingOptions {
  organizationId: string;
  userId: string;
  apply: boolean;
}

export interface OnboardingResult {
  organizationId: string;
  userId: string;
  roleName: string;
  memberAlreadyPresent: boolean;
  roleAlreadyAssigned: boolean;
  changes: string[];
  applied: boolean;
}

class SafeManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeManagementError';
  }
}

function requireEnv(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value)
    throw new SafeManagementError(`Missing required server environment variable ${name}.`);
  return value;
}

function parseDomain(value: string): string {
  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    throw new SafeManagementError('AUTH0_DOMAIN must be a valid Auth0 tenant host.');
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new SafeManagementError('AUTH0_DOMAIN must be an HTTPS tenant host without a path.');
  }
  return url.host.toLowerCase();
}

function validateOrganizationId(value: string): void {
  if (!/^org_[A-Za-z0-9]{4,64}$/.test(value)) {
    throw new SafeManagementError('Organization ID must be a valid org_ identifier.');
  }
}

function validateUserId(value: string): void {
  if (
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\|[A-Za-z0-9._:@+-]{1,128}$/.test(value)
  ) {
    throw new SafeManagementError(
      'User ID must be a valid Auth0 user_id (for example google-oauth2|…).'
    );
  }
}

function validateRoleId(value: string): void {
  if (!/^rol_[A-Za-z0-9]{4,64}$/.test(value)) {
    throw new SafeManagementError(
      'AUTH0_BASELINE_READONLY_ROLE_ID must be a valid rol_ identifier.'
    );
  }
}

function allowedOrganizationIds(environment: NodeJS.ProcessEnv): Set<string> {
  const raw = environment.TRACEMIND_ORG_IDS?.trim() || environment.TRACEMIND_ORG_ID?.trim();
  if (!raw) {
    throw new SafeManagementError('Set TRACEMIND_ORG_ID or TRACEMIND_ORG_IDS before onboarding.');
  }
  const ids = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!ids.length || ids.some((id) => !/^org_[A-Za-z0-9]{4,64}$/.test(id))) {
    throw new SafeManagementError('Configured TraceMind organization allowlist is invalid.');
  }
  return new Set(ids);
}

function parseArgs(args: string[]): OnboardingOptions {
  let organizationId: string | undefined;
  let userId: string | undefined;
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') {
      if (apply) throw new SafeManagementError('Specify --apply at most once.');
      apply = true;
      continue;
    }
    if (argument === '--org-id' || argument === '--user-id') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new SafeManagementError(`${argument} requires an explicit value.`);
      }
      if (argument === '--org-id') {
        if (organizationId) throw new SafeManagementError('Specify --org-id at most once.');
        organizationId = value;
      } else {
        if (userId) throw new SafeManagementError('Specify --user-id at most once.');
        userId = value;
      }
      index += 1;
      continue;
    }
    throw new SafeManagementError(`Unknown argument: ${argument}`);
  }
  if (!organizationId || !userId) {
    throw new SafeManagementError(
      'Usage: npm run auth0:org:onboard-member -- --org-id org_… --user-id provider|id [--apply]'
    );
  }
  validateOrganizationId(organizationId);
  validateUserId(userId);
  return { organizationId, userId, apply };
}

function objectValue(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (raw.length > 256_000)
    throw new SafeManagementError('Auth0 response exceeded the safe size limit.');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new SafeManagementError(`Auth0 returned an invalid response (HTTP ${response.status}).`);
  }
}

function responseError(response: Response): SafeManagementError {
  // Do not print the provider response body: it can contain profile details or credentials.
  return new SafeManagementError(`Auth0 Management API request failed (HTTP ${response.status}).`);
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    throw new SafeManagementError('Auth0 Management API request failed (network or timeout).');
  } finally {
    clearTimeout(timer);
  }
}

async function getManagementToken(
  fetchImpl: FetchLike,
  domain: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const response = await fetchWithTimeout(fetchImpl, `https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience: `https://${domain}/api/v2/`,
      scope: MANAGEMENT_SCOPES.join(' '),
    }),
  });
  const body = objectValue(await readJson(response));
  if (!response.ok) throw responseError(response);
  if (typeof body?.access_token !== 'string' || !body.access_token) {
    throw new SafeManagementError('Auth0 did not issue a Management API access token.');
  }
  return body.access_token;
}

async function managementRequest(
  fetchImpl: FetchLike,
  domain: string,
  accessToken: string,
  path: string,
  method = 'GET',
  body?: JsonRecord,
  allowNotFound = false
): Promise<unknown> {
  const response = await fetchWithTimeout(fetchImpl, `https://${domain}/api/v2/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (allowNotFound && response.status === 404) return undefined;
  const result = await readJson(response);
  if (!response.ok) throw responseError(response);
  return result;
}

async function managementList(
  fetchImpl: FetchLike,
  domain: string,
  accessToken: string,
  path: string,
  allowNotFound = false
): Promise<JsonRecord[] | undefined> {
  const entries: JsonRecord[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const value = await managementRequest(
      fetchImpl,
      domain,
      accessToken,
      `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`,
      'GET',
      undefined,
      allowNotFound && page === 0
    );
    if (value === undefined && page === 0) return undefined;
    if (!Array.isArray(value)) {
      throw new SafeManagementError('Auth0 returned an invalid paginated list response.');
    }
    const pageEntries = value.map(objectValue);
    if (pageEntries.some((entry) => !entry)) {
      throw new SafeManagementError('Auth0 returned an invalid paginated list entry.');
    }
    entries.push(...(pageEntries as JsonRecord[]));
    if (value.length < PAGE_SIZE) return entries;
  }
  throw new SafeManagementError('Auth0 list exceeded the maximum safe pagination limit.');
}

function assertRoleIsBaselineReadOnly(
  role: JsonRecord,
  permissionsValue: unknown,
  apiIdentifier: string
): string {
  const roleName = typeof role.name === 'string' ? role.name : '';
  if (!roleName || !/read[- ]?only/i.test(roleName)) {
    throw new SafeManagementError('Configured role is not named as a read-only role.');
  }
  if (!Array.isArray(permissionsValue) || permissionsValue.length === 0) {
    throw new SafeManagementError('Configured read-only role has no verifiable API permissions.');
  }
  const permissions = permissionsValue.map(objectValue);
  if (
    permissions.some(
      (permission) =>
        !permission ||
        permission.resource_server_identifier !== apiIdentifier ||
        typeof permission.permission_name !== 'string' ||
        !READ_ONLY_PERMISSIONS.has(permission.permission_name)
    )
  ) {
    throw new SafeManagementError(
      'Configured role has permissions outside TraceMind’s approved read-only permission set.'
    );
  }
  const permissionNames = new Set(
    permissions
      .map((permission) => permission?.permission_name)
      .filter((name): name is string => typeof name === 'string')
  );
  if (REQUIRED_BASELINE_PERMISSIONS.some((permission) => !permissionNames.has(permission))) {
    throw new SafeManagementError(
      `Configured read-only role must include the baseline permissions: ${REQUIRED_BASELINE_PERMISSIONS.join(', ')}.`
    );
  }
  return roleName;
}

export async function onboardOrganizationMember(
  options: OnboardingOptions,
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch
): Promise<OnboardingResult> {
  validateOrganizationId(options.organizationId);
  validateUserId(options.userId);
  const organizations = allowedOrganizationIds(environment);
  if (!organizations.has(options.organizationId)) {
    throw new SafeManagementError(
      'Requested organization is not in the TraceMind organization allowlist.'
    );
  }

  const domain = parseDomain(requireEnv(environment, 'AUTH0_DOMAIN'));
  const clientId = requireEnv(environment, 'AUTH0_MGMT_CLIENT_ID');
  const clientSecret = requireEnv(environment, 'AUTH0_MGMT_CLIENT_SECRET');
  const roleId = requireEnv(environment, 'AUTH0_BASELINE_READONLY_ROLE_ID');
  const apiIdentifier = requireEnv(environment, 'AUTH0_AUDIENCE');
  validateRoleId(roleId);
  let apiUrl: URL;
  try {
    apiUrl = new URL(apiIdentifier);
  } catch {
    throw new SafeManagementError('AUTH0_AUDIENCE must be a valid API identifier URL.');
  }
  if (!['https:', 'http:'].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password) {
    throw new SafeManagementError('AUTH0_AUDIENCE must be an HTTP(S) API identifier URL.');
  }

  const token = await getManagementToken(fetchImpl, domain, clientId, clientSecret);
  const orgSegment = encodeURIComponent(options.organizationId);
  const userSegment = encodeURIComponent(options.userId);
  const roleSegment = encodeURIComponent(roleId);

  const user = objectValue(
    await managementRequest(fetchImpl, domain, token, `users/${userSegment}`)
  );
  if (!user || user.user_id !== options.userId) {
    throw new SafeManagementError('Requested Auth0 user was not found.');
  }
  const organization = objectValue(
    await managementRequest(fetchImpl, domain, token, `organizations/${orgSegment}`)
  );
  if (!organization || organization.id !== options.organizationId) {
    throw new SafeManagementError('Requested Auth0 organization was not found.');
  }
  const role = objectValue(
    await managementRequest(fetchImpl, domain, token, `roles/${roleSegment}`)
  );
  if (!role || role.id !== roleId)
    throw new SafeManagementError('Configured baseline role was not found.');
  const rolePermissions = await managementList(
    fetchImpl,
    domain,
    token,
    `roles/${roleSegment}/permissions`
  );
  const roleName = assertRoleIsBaselineReadOnly(role, rolePermissions, apiIdentifier);

  // Auth0 documents GET member roles as the organization-context membership/role source.
  const currentRolesValue = await managementList(
    fetchImpl,
    domain,
    token,
    `organizations/${orgSegment}/members/${userSegment}/roles`,
    true
  );
  const memberAlreadyPresent = currentRolesValue !== undefined;
  const roleAlreadyAssigned = (currentRolesValue ?? []).some(
    (currentRole) => currentRole.id === roleId
  );
  const changes: string[] = [];
  if (!memberAlreadyPresent) changes.push('add user to organization');
  if (!roleAlreadyAssigned) changes.push(`assign ${roleName} organization role`);

  if (options.apply && changes.length > 0) {
    if (!memberAlreadyPresent) {
      await managementRequest(
        fetchImpl,
        domain,
        token,
        `organizations/${orgSegment}/members`,
        'POST',
        {
          members: [options.userId],
        }
      );
    }
    if (!roleAlreadyAssigned) {
      await managementRequest(
        fetchImpl,
        domain,
        token,
        `organizations/${orgSegment}/members/${userSegment}/roles`,
        'POST',
        { roles: [roleId] }
      );
    }
  }

  return {
    organizationId: options.organizationId,
    userId: options.userId,
    roleName,
    memberAlreadyPresent,
    roleAlreadyAssigned,
    changes,
    applied: options.apply,
  };
}

function printUsage(): void {
  console.log(
    [
      'Auth0 organization member onboarding (dry-run by default)',
      'Usage: npm run auth0:org:onboard-member -- --org-id org_… --user-id provider|id [--apply]',
      'Required server environment: AUTH0_DOMAIN, AUTH0_MGMT_CLIENT_ID, AUTH0_MGMT_CLIENT_SECRET,',
      'AUTH0_AUDIENCE, AUTH0_BASELINE_READONLY_ROLE_ID, and TRACEMIND_ORG_ID or TRACEMIND_ORG_IDS.',
      'The Management API client needs read:users, read:organizations, read:roles,',
      'read:organization_member_roles, create:organization_members, and create:organization_member_roles.',
      'Use --apply to make the reviewed changes; without it, the script only reports a dry-run plan.',
    ].join('\n')
  );
}

export async function main(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env
): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    printUsage();
    return 0;
  }
  try {
    const options = parseArgs(args);
    const result = await onboardOrganizationMember(options, environment);
    console.log(
      JSON.stringify(
        {
          mode: result.applied ? 'apply' : 'dry-run',
          organizationId: result.organizationId,
          userId: result.userId,
          roleName: result.roleName,
          memberAlreadyPresent: result.memberAlreadyPresent,
          roleAlreadyAssigned: result.roleAlreadyAssigned,
          plannedOrAppliedChanges: result.changes,
          result: result.applied ? 'applied' : 'no changes made',
        },
        null,
        2
      )
    );
    return 0;
  } catch (error) {
    const message =
      error instanceof SafeManagementError ? error.message : 'Auth0 onboarding failed.';
    console.error(`Auth0 onboarding failed: ${message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
