import { fetchUser } from "./user";
import { greet } from "./a";
import { nameOf } from "./b";
import { exists } from "./c";
import { idsExist } from "./d";

console.log(fetchUser(1)?.name);
console.log(greet(1), nameOf(2), exists(1), idsExist([1, 2]));
