import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { env, googleOAuthEnabled } from "../config/env";
import type { OAuthProfile } from "../services/auth.service";
import { AuthProvider } from "@prisma/client";

export interface GoogleOAuthProfile {
  providerId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
}

if (googleOAuthEnabled) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
        callbackURL: `${env.API_BASE_URL}/auth/google/callback`,
        scope: ["profile", "email"],
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value;
          if (!email) {
            return done(new Error("Google account has no email"), undefined);
          }

          const googleProfile: GoogleOAuthProfile = {
            providerId: profile.id,
            email,
            firstName: profile.name?.givenName,
            lastName: profile.name?.familyName,
            avatarUrl: profile.photos?.[0]?.value,
          };

          done(null, googleProfile);
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    )
  );
}

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user as GoogleOAuthProfile);
});

export function toOAuthProfile(profile: GoogleOAuthProfile): OAuthProfile {
  return {
    provider: AuthProvider.GOOGLE,
    providerId: profile.providerId,
    email: profile.email,
    firstName: profile.firstName,
    lastName: profile.lastName,
    avatarUrl: profile.avatarUrl,
  };
}

export default passport;
