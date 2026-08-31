const { PrismaClient } = require("@prisma/client");

async function main() {
  const [, , type, email] = process.argv;

  if (!type || !email) {
    console.error("Usage: node scripts/get-email-token.js <verify|reset> <email>");
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    if (type === "verify") {
      const token = await prisma.emailVerificationToken.findFirst({
        where: { user: { email: email.toLowerCase() }, usedAt: null },
        orderBy: { createdAt: "desc" },
      });
      if (!token) process.exit(2);
      process.stdout.write(token.token);
      return;
    }

    if (type === "reset") {
      const token = await prisma.passwordResetToken.findFirst({
        where: { user: { email: email.toLowerCase() }, usedAt: null },
        orderBy: { createdAt: "desc" },
      });
      if (!token) process.exit(2);
      process.stdout.write(token.token);
      return;
    }

    console.error("Type must be verify or reset");
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
