// src/app/api/commission/listing/route.ts
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api/withAuth";
import { rotateToken } from "@/lib/api/rotateToken";
import { handleError } from "@/lib/utils/errorHandler";
import {
  createListingFromForm,
  getArtistListings,
} from "@/lib/services/commissionListing.service";

// Create a new commission listing
// Create a new commission listing
export async function POST(req: NextRequest) {
  try {
    return withAuth(async (session) => {
      const formData = await req.formData();

      // Create the listing
      const newListing = await createListingFromForm(session.id, formData);

      // Return the newly created listing
      const response = NextResponse.json({
        message: "Commission created successfully",
        listing: newListing,
      });

      // Rotate refresh token if needed
      rotateToken(response, session);
      return response;
    });
  } catch (error: any) {
    return handleError(error);
  }
}

// Get all active listings for the authenticated artist
export async function GET() {
  try {
    return withAuth(async (session) => {
      const listings = await getArtistListings(session.id);

      const response = NextResponse.json({ listings });

      rotateToken(response, session);
      return response;
    });
  } catch (error) {
    return handleError(error);
  }
}
