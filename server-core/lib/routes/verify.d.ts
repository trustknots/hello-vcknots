import { VcknotsContext } from '@trustknots/vcknots';
import { Hono } from 'hono';
export declare const createVerifierRouter: (context: VcknotsContext, baseUrl: string) => Hono<import("hono/types").BlankEnv, import("hono/types").BlankSchema, "/">;
