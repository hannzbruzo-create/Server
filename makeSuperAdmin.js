const db = require("./database");

const username = "admin1";

const result = db.prepare(`
  UPDATE admins
  SET role = 'superadmin'
  WHERE username = ?
`).run(username);

if (result.changes === 0) {
  console.log("Admin not found");
} else {
  console.log(`${username} is now a superadmin`);
}