import { fetchUser } from "./user";

export function idsExist(ids: number[]): boolean {
  return ids.every((id) => fetchUser(id) !== undefined);
}
