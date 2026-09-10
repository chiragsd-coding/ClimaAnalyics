/** One-off RBAC test helper: demote user 4 to viewer, or cleanup throwaways. */
import { db } from "~/lib/db";

const mode = process.argv[2];

db.run("PRAGMA foreign_keys = ON");

if (mode === "viewer") {
  db.run("UPDATE users SET role = ? WHERE email LIKE ?", ["viewer", "%throwaway.local"]);
  console.log("users:", db.query("SELECT id,email,role FROM users").all());
} else if (mode === "cleanup") {
  db.run("DELETE FROM areas WHERE created_by IN (SELECT id FROM users WHERE email LIKE ?)", [
    "%throwaway.local",
  ]);
  db.run("DELETE FROM users WHERE email LIKE ?", ["%throwaway.local"]);
  console.log("users:", db.query("SELECT id,email,role FROM users").all());
  console.log("areas:", db.query("SELECT id,name,is_demo FROM areas").all());
  console.log("sessions:", db.query("SELECT COUNT(*) AS n FROM sessions").get());
  console.log("access:", db.query("SELECT area_id, user_id FROM area_access").all());
  console.log("analyses:", db.query("SELECT COUNT(*) AS n FROM analyses").get());
} else {
  console.error("usage: bun scripts/rbac-test.ts [viewer|cleanup]");
}
