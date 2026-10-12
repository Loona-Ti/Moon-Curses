import { zSafe } from "@/utils";
import { z } from "zod";

export const Service_Fansly_Schema = z.object({
  enable: zSafe(z.coerce.boolean(), false),
}).default({});

export type Fansly_State = z.infer<typeof Service_Fansly_Schema>;
