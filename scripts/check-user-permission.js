const { PrismaClient } = require("@prisma/client");

const email = process.argv[2] || "j.sunny9291@gmail.com";

async function main() {
  const prisma = new PrismaClient();
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: {
      id: true,
      email: true,
      resumeBuilderEnabled: true,
      emailVerified: true,
      onboardingCompleted: true,
      updatedAt: true,
    },
  });
  console.log(JSON.stringify(user, null, 2));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
