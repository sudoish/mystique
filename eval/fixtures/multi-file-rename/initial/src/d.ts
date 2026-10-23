import { getUser } from "./user";

export function idsExist(ids: number[]): boolean {
  return ids.every((id) => getUser(id) !== undefined);
}
