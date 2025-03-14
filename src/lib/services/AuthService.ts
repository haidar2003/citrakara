// src/lib/services/AuthService.ts
import bcrypt from "bcryptjs";
import { findUserByUsername } from "@/lib/repositories/UserRepository";
import { generateAccessToken, generateRefreshToken } from "@/lib/utils/jwt";

/** Login user (credentials flow) */
export async function loginUser(username: string, password: string) {
  const user = await findUserByUsername(username);
  if (!user || user.isDeleted) throw new Error("Invalid credentials");

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) throw new Error("Invalid credentials");

  const accessToken = generateAccessToken({ id: user._id.toString(), username: user.username });
  const refreshToken = generateRefreshToken({ id: user._id.toString(), username: user.username });

  return { user, accessToken, refreshToken };
}
