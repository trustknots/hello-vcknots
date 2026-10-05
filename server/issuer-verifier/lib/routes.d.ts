import { Hono } from 'hono';
import { VcknotsContext } from '@trustknots/vcknots';
export declare const globalState: {
    currentUsername: string;
    lastVerifiedUsername: string;
    verificationStatus: string;
};
export declare const createCustomRouter: (context: VcknotsContext, baseUrl: string) => Hono<import("hono/types").BlankEnv, import("hono/types").BlankSchema, "/">;
