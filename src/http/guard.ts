import { Inject, Injectable, SetMetadata } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

export const PROVIDER_IDENTITY = Symbol("ProviderIdentity");
export const IS_PUBLIC = "isPublic";

export const Public = () => SetMetadata(IS_PUBLIC, true);

export interface ProviderIdentity {
  authenticate(request: Request): void;
}

@Injectable()
export class AnonymousProviderIdentity implements ProviderIdentity {
  authenticate(_request: Request): void {}
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentity,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    this.identity.authenticate(context.switchToHttp().getRequest());
    return true;
  }
}
