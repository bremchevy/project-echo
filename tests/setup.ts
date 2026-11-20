import { execFileSync } from 'node:child_process';
export default function setup() {
  execFileSync('npx',['prisma','migrate','deploy'],{stdio:'inherit'});
}
