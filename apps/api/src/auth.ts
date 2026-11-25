import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '@seedingsys/config';
import { CONFIG, type Role } from './tokens';

export const ROLES_KEY = 'roles';
/** Roles allowed on a handler (admin is always allowed). No decorator = any authenticated role. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
/** Endpoints on this handler authenticate directly against a profile-scoped token. */
export const ProfileToken = () => SetMetadata('profile-token', true);

export interface Principal {
  role: Role;
  actor: string;
}

/**
 * Bearer-token RBAC for the pilot (tokens → roles in API_TOKENS). Replace with SSO before
 * opening the web UI beyond the operations team.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly tokens: Array<{ token: Buffer; role: Role; label: string }>;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CONFIG) cfg: AppConfig,
  ) {
    const map = JSON.parse(cfg.API_TOKENS) as Record<string, Role>;
    this.tokens = Object.entries(map).map(([t, role], i) => ({ token: Buffer.from(t), role, label: `${role}#${i + 1}` }));
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.get<boolean>('profile-token', ctx.getHandler())) return true;
    const req = ctx.switchToHttp().getRequest();
    if (req.path === '/health') return true;
    const h = String(req.headers.authorization ?? '');
    const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
    const hit = this.tokens.find((t) => t.token.length === given.length && timingSafeEqual(t.token, given));
    if (!hit) throw new UnauthorizedException();
    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (allowed && hit.role !== 'admin' && !allowed.includes(hit.role)) throw new ForbiddenException();
    req.principal = { role: hit.role, actor: `api:${hit.label}` } satisfies Principal;
    return true;
  }
}
