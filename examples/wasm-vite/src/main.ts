import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { connectWasm, provisionWasm } from "../../../src/client/wasm.js";
import "./style.css";

const SCHEMA = `module default {
  type Person {
    required name: str;
    age: int64;
  }
}`;

const STORAGE_KEY = "sqlite-ts-wasm-demo";

const decodeDatabase = (encoded: string): Uint8Array => {
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const encodeDatabase = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const SQL = await initSqlJs({ locateFile: () => wasmUrl });
const saved = localStorage.getItem(STORAGE_KEY);
const db = new SQL.Database(saved ? decodeDatabase(saved) : undefined);

if (!saved) {
  provisionWasm(db, SCHEMA);
}

const client = connectWasm(db);

if (!saved) {
  await client.query("insert default::Person { name := 'Ada', age := 36 };");
  await client.query("insert default::Person { name := 'Linus', age := 54 };");
  localStorage.setItem(STORAGE_KEY, encodeDatabase(db.export()));
}

const peopleElement = document.querySelector<HTMLOListElement>("#people")!;
const countElement = document.querySelector<HTMLSpanElement>("#count")!;
const statusElement = document.querySelector<HTMLSpanElement>("#status")!;
const form = document.querySelector<HTMLFormElement>("#person-form")!;

const renderPeople = async (): Promise<void> => {
  const people = await client.query<{ id: string; name: string; age: number | null }>(
    "select default::Person { id, name, age } order by .name;",
  );

  peopleElement.replaceChildren(
    ...people.map((person) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      const age = document.createElement("small");
      name.textContent = person.name;
      age.textContent = `${person.age ?? "?"} years`;
      item.append(name, age);
      return item;
    }),
  );
  countElement.textContent = `${people.length} ${people.length === 1 ? "row" : "rows"}`;
  statusElement.textContent = "WASM ready";
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  statusElement.textContent = "Compiling query...";

  try {
    await client.query(
      "insert default::Person { name := <str>$name, age := <int64>$age };",
      { name: String(data.get("name")), age: Number(data.get("age")) },
    );
    localStorage.setItem(STORAGE_KEY, encodeDatabase(db.export()));
    await renderPeople();
  } catch (error) {
    statusElement.textContent = error instanceof Error ? error.message : "Query failed";
  }
});

document.querySelector<HTMLButtonElement>("#reset")!.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
});

await renderPeople();
