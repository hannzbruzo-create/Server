    const bcrypt = require("bcrypt");
const db = require("./database");

async function createAdmin() {
  const name = "Admin 2";
  const username = "Hannz";
  const password = "Hello";

  // Convert password into a secure hash
  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const result = db.prepare(`
      INSERT INTO admins (
        name,
        username,
        password_hash
      )
      VALUES (?, ?, ?)
    `).run(
      name,
      username,
      passwordHash
    );

    console.log("Admin created successfully!");
    console.log("Admin ID:", result.lastInsertRowid);

  } catch (error) {
    console.error("Could not create admin:", error.message);
  }
}

createAdmin();