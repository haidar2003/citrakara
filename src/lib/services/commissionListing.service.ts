// src/lib/services/commissionListing.service.ts

import { Types } from "mongoose";
import { toObjectId } from "@/lib/utils/toObjectId";
import { uploadGalleryImagesToR2 } from "@/lib/utils/cloudflare";
import { getUserDefaultTos } from "./tos.service";
import { findUserByUsername } from "@/lib/db/repositories/user.repository";
import { ID } from "../db/models/commissionListing.model";
import {
  createCommissionListing,
  findCommissionListingById,
  findActiveListingsByArtist,
  updateCommissionListing,
  updateCommissionListingComponents,
  softDeleteListing,
  searchListings,
  adjustSlotsUsed,
  addQuestion,
  removeQuestion,
  findBookmarkedListingsWithArtist,
  searchListingsEnhanced,
  CommissionListingPayload,
} from "@/lib/db/repositories/commissionListing.repository";

/* ======================================================================
 * Types and Utilities
 * ====================================================================== */

/**
 * Custom error class for HTTP status mapping
 */
export class HttpError extends Error {
  status: number;

  constructor(message: string, status: number = 400) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

/* ======================================================================
 * Helper Functions
 * ====================================================================== */

/**
 * Generate sequential IDs for new components
 *
 * @param items Array of items that may or may not have IDs
 * @param startId Starting ID value for new items
 * @returns Array of items with guaranteed IDs
 */
function generateIds<T extends { id?: ID }>(
  items: T[],
  startId: ID = 1
): (T & { id: ID })[] {
  return items.map((item, index) => ({
    ...item,
    id: item.id ?? startId + index,
  }));
}

/**
 * Convert old string questions format to new ID-based format
 *
 * @param questions Optional array of string questions
 * @returns Array of questions with IDs
 */
function convertQuestionsToIdFormat(
  questions?: string[]
): { id: ID; text: string }[] {
  if (!questions?.length) return [];
  return questions.map((text, index) => ({
    id: index + 1,
    text: text,
  }));
}

/**
 * Computes the price range (min/max) for a commission listing
 * based on all options, selections, and addons
 *
 * @param input Commission listing payload
 * @returns Object with min and max prices
 */
function computePriceRange(input: Partial<CommissionListingPayload>) {
  let min = input.basePrice ?? 0;
  let max = input.basePrice ?? 0;

  const addPrices = (items?: { price: number }[]) => {
    if (!items?.length) return;
    const prices = items.map((item) => item.price);
    min += Math.min(...prices);
    max += prices.reduce((sum, price) => sum + price, 0); // Sum all possible addons for max
  };

  // Add general options
  input.generalOptions?.optionGroups?.forEach((group) =>
    addPrices(group.selections)
  );
  addPrices(input.generalOptions?.addons);

  // Add subject options
  input.subjectOptions?.forEach((subject) => {
    subject.optionGroups?.forEach((group) => addPrices(group.selections));
    addPrices(subject.addons);
  });

  return { min, max };
}

/**
 * Extract only allowed fields from JSON for commission listing
 *
 * @param rawPayload Raw payload from form data
 * @returns Sanitized payload with only allowed fields
 */
function sanitizePayload(rawPayload: any): Partial<CommissionListingPayload> {
  const allowedFields = [
    "title",
    "description",
    "tags",
    "slots",
    // "tos",
    "type",
    "flow",
    "deadline",
    "basePrice",
    "cancelationFee",
    "latePenaltyPercent",
    "graceDays",
    "currency",
    "allowContractChange",
    "changeable",
    "revisions",
    "milestones",
    "generalOptions",
    "subjectOptions",
  ];

  const sanitized: any = {};

  for (const field of allowedFields) {
    if (field in rawPayload) {
      sanitized[field] = rawPayload[field];
    }
  }

  return sanitized;
}

/**
 * Validates a commission listing payload before creation
 *
 * @param payload Commission listing data to validate
 * @throws HttpError if validation fails
 */
function validateListingPayload(payload: Partial<CommissionListingPayload>) {
  console.log("Validating payload...");
  // Check required fields
  const requiredFields = [
    "title",
    "type",
    "flow",
    "artistId",
    "thumbnailIdx",
    "samples",
    "deadline",
    "basePrice",
    "cancelationFee",
  ];

  console.log("Validating payload:", payload);

  for (const field of requiredFields) {
    const value = payload[field as keyof CommissionListingPayload];
    console.log("Checking field:", field, value);
    if (value === undefined || value === null) {
      throw new HttpError(`Required field missing: ${field}`);
    }
  }

  // Check milestone requirements for milestone flow
  if (
    payload.flow === "milestone" &&
    (!payload.milestones || !payload.milestones.length)
  ) {
    throw new HttpError("Milestone flow requires milestones array");
  }

  // Validate milestone percentages sum to 100%
  if (payload.milestones && payload.milestones.length > 0) {
    const sum = payload.milestones.reduce(
      (acc, milestone) => acc + milestone.percent,
      0
    );
    if (sum !== 100) {
      throw new HttpError("Milestone percentages must sum to 100%");
    }
  }

  // Enforce correct revision policy based on flow
  if (payload.flow === "standard" && payload.revisions?.type === "milestone") {
    throw new HttpError("Standard flow cannot have milestone revision type");
  }

  // Validate slots
  if (payload.slots === 0) {
    throw new HttpError("Slots cannot be 0");
  }
}

/**
 * Process payload to convert legacy format to ID-based format
 *
 * @param payload Raw commission listing payload
 * @returns Processed payload with IDs assigned to all components
 */
function processPayloadWithIds(
  payload: Partial<CommissionListingPayload>
): Partial<CommissionListingPayload> {
  const processed = { ...payload };

  // Process milestones
  if (processed.milestones) {
    processed.milestones = generateIds(processed.milestones);
  }

  // Process general options
  if (processed.generalOptions) {
    const generalOptions = { ...processed.generalOptions };

    // Process option groups
    if (generalOptions.optionGroups) {
      generalOptions.optionGroups = generateIds(
        generalOptions.optionGroups
      ).map((group) => ({
        ...group,
        selections: generateIds(group.selections),
      }));
    }

    // Process addons
    if (generalOptions.addons) {
      generalOptions.addons = generateIds(generalOptions.addons);
    }

    // Convert questions from old string format to new ID-based format
    if (generalOptions.questions) {
      const questionsArr = Array.isArray(generalOptions.questions)
        ? generalOptions.questions
        : [];
      generalOptions.questions = questionsArr.map((q, idx) => {
        // Handle both string questions and objects with 'title' field (legacy format)
        if (typeof q === "string") {
          return { id: idx + 1, text: q };
        } else if (typeof q === "object" && q !== null) {
          if ("title" in q) {
            return { id: idx + 1, text: q.title as string };
          } else if ("label" in q) {
            return {
              id: "id" in q ? (q.id as ID) : idx + 1,
              text: q.label as string,
            };
          }
        }
        return { id: idx + 1, text: String(q) };
      });
    }

    processed.generalOptions = generalOptions;
  }

  // Process subject options
  if (processed.subjectOptions) {
    processed.subjectOptions = generateIds(processed.subjectOptions).map(
      (subject) => {
        const processedSubject = { ...subject };

        // Process option groups
        if (processedSubject.optionGroups) {
          processedSubject.optionGroups = generateIds(
            processedSubject.optionGroups
          ).map((group) => ({
            ...group,
            selections: generateIds(group.selections),
          }));
        }

        // Process addons
        if (processedSubject.addons) {
          processedSubject.addons = generateIds(processedSubject.addons);
        }

        // Convert questions from old string format to new ID-based format
        if (processedSubject.questions) {
          const questionsArr = Array.isArray(processedSubject.questions)
            ? processedSubject.questions
            : [];
          processedSubject.questions = questionsArr.map((q, idx) => {
            // Handle both string questions and objects with 'title' field (legacy format)
            if (typeof q === "string") {
              return { id: idx + 1, text: q };
            } else if (typeof q === "object" && q !== null) {
              if ("title" in q) {
                return { id: idx + 1, text: q.title as string };
              } else if ("label" in q) {
                return {
                  id: "id" in q ? (q.id as ID) : idx + 1,
                  text: q.label as string,
                };
              }
            }
            return { id: idx + 1, text: String(q) };
          });
        }

        return processedSubject;
      }
    );
  }

  return processed;
}

/* ======================================================================
 * Main Service Functions - Creation and Updates
 * ====================================================================== */

/**
 * Create a commission listing from form data
 * Handles file uploads to R2 and JSON parsing
 *
 * @param artistId ID of the artist creating the listing
 * @param form FormData containing listing details and images
 * @returns Created commission listing object
 * @throws HttpError if validation fails
 */
export async function createListingFromForm(artistId: string, form: FormData) {
  // 1. Parse & sanitize JSON payload
  let jsonPayload: any;
  try {
    const raw = form.get("payload");
    jsonPayload =
      raw && typeof raw === "string" ? sanitizePayload(JSON.parse(raw)) : {};
  } catch {
    throw new HttpError("Invalid JSON payload", 400);
  }

  // 2. Ensure essential string fields
  for (const field of ["title", "type", "flow"] as const) {
    const v = form.get(field);
    if (!v || typeof v !== "string") {
      throw new HttpError(`Required field missing: ${field}`, 400);
    }
  }

  console.log("Form data (raw):", form);

  const tos = (await getUserDefaultTos(artistId))._id.toString();

  // 3. Build our partial listingData (without thumbnail/samples yet)
  const listingData: Partial<CommissionListingPayload> = {
    ...jsonPayload,
    artistId: toObjectId(artistId),
    title: form.get("title")!.toString(),
    tos: tos,
    type: form.get("type") as "template" | "custom",
    flow: form.get("flow") as "standard" | "milestone",
    basePrice: Number(form.get("basePrice") ?? 0),
    description: jsonPayload.description ?? [],
  };

  // 4. Allow override of currency if provided
  const currencyVal = form.get("currency");
  if (typeof currencyVal === "string") {
    listingData.currency = currencyVal;
  }

  // 5. Extract thumbnail blob vs URL & collect sample blobs
  const sampleBlobs: Blob[] = [];
  form.forEach((value, key) => {
    if (key === "samples[]" && value instanceof Blob) {
      sampleBlobs.push(value);
    }
  });

  // 6. Upload all blobs in one go
  const toUpload = sampleBlobs;
  const uploadedUrls = await uploadGalleryImagesToR2(
    toUpload,
    artistId,
    "listing"
  );
  listingData.samples = uploadedUrls;

  // 7. Assign samples and calculate thumbnailIdx
  const thumbnailIdx = Number(form.get("thumbnailIdx") ?? 0);

  if (
    typeof thumbnailIdx !== "number" ||
    thumbnailIdx < 0 ||
    thumbnailIdx >= listingData.samples.length
  ) {
    throw new HttpError("Invalid thumbnail index", 400);
  } else {
    listingData.thumbnailIdx = thumbnailIdx;
  }

  console.log("Listing data (after upload):", listingData);

  // 8. Process payload to ensure all components have IDs
  const processedData = processPayloadWithIds(listingData);

  // 9. Validate *after* thumbnail is set (so no more missing‐thumbnail errors)
  validateListingPayload(processedData);

  // 10. Compute price range & persist
  const price = computePriceRange(processedData);
  return createCommissionListing({
    ...(processedData as CommissionListingPayload),
    price,
  });
}

/**
 * Update a commission listing from form data
 * Handles file uploads to R2 and JSON parsing
 *
 * @param artistId ID of the artist updating the listing
 * @param listingId ID of the listing to update
 * @param form FormData containing updated listing details and images
 * @returns Updated commission listing object
 * @throws HttpError if validation fails or user not authorized
 */
export async function updateListingFromForm(
  artistId: string,
  listingId: string,
  form: FormData
) {
  // 1. Fetch & auth the existing listing
  const existing = await findCommissionListingById(listingId);
  if (!existing) throw new HttpError("Listing not found", 404);
  if (existing.artistId.toString() !== artistId) {
    throw new HttpError("Not authorized to update this listing", 403);
  }

  const existingData = existing.toObject();

  // 2. Parse & sanitize JSON payload
  let jsonPayload: any;
  try {
    const raw = form.get("payload");
    jsonPayload =
      raw && typeof raw === "string" ? sanitizePayload(JSON.parse(raw)) : {};
  } catch {
    throw new HttpError("Invalid JSON payload", 400);
  }

  // 3. Build partial listingData from form fields or fall back to existing values
  const listingData: Partial<CommissionListingPayload> = {
    ...jsonPayload,
    artistId: toObjectId(artistId),
    title: (form.get("title") || existingData.title)!.toString(),
    tos: await getUserDefaultTos(artistId).toString(),
    type: (form.get("type") as "template" | "custom") || existingData.type,
    flow: (form.get("flow") as "standard" | "milestone") || existingData.flow,
    basePrice: Number(form.get("basePrice") ?? existingData.basePrice),
    description: jsonPayload.description ?? existingData.description ?? [],
  };

  // 4. Handle currency if provided
  const currencyVal = form.get("currency");
  if (typeof currencyVal === "string") {
    listingData.currency = currencyVal;
  }

  // 5. pull existing URLs and new blobs out of FormData
  const existingSamples = form
    .getAll("existingSamples[]")
    .map((v) => v.toString());

  const sampleBlobs = form
    .getAll("samples[]")
    .filter((v) => v instanceof Blob) as Blob[];

  // 6. if either URLs or blobs were submitted, rebuild the array
  if (existingSamples.length > 0 || sampleBlobs.length > 0) {
    // upload new files (if any)
    let uploadedUrls: string[] = [];
    if (sampleBlobs.length > 0) {
      uploadedUrls = await uploadGalleryImagesToR2(
        sampleBlobs,
        artistId,
        "listing"
      );
    }

    // combine exactly in the order the client specified:
    listingData.samples = [...existingSamples, ...uploadedUrls];

    // now update thumbnailIdx safely
    const thumbnailIdx = Number(form.get("thumbnailIdx") ?? 0);
    if (thumbnailIdx < 0 || thumbnailIdx >= listingData.samples.length) {
      throw new HttpError("Invalid thumbnail index", 400);
    }
    listingData.thumbnailIdx = thumbnailIdx;
  } else {
    // no change → keep everything as-is
    listingData.samples = existingData.samples;
    listingData.thumbnailIdx = existingData.thumbnailIdx;
  }

  console.log("Update listing data:", listingData);

  // 7. Process payload to ensure all components have IDs, preserving existing IDs
  const processedData = processPayloadWithIds(listingData);

  // 8. Merge with existing data for validation
  const merged: Partial<CommissionListingPayload> = {
    ...existingData,
    ...processedData,
  };

  // 9. Validate the merged data
  validateListingPayload(merged);

  // 10. Compute price range
  const price = computePriceRange(merged);
  processedData.price = price;

  // 11. Update listing with all processed fields
  return updateCommissionListingComponents(listingId, processedData);
}

/**
 * Update a commission listing with JSON data
 *
 * @param artistId ID of the artist updating the listing
 * @param listingId ID of the listing to update
 * @param updates Partial payload with fields to update
 * @returns Updated commission listing object
 * @throws HttpError if validation fails or user not authorized
 */
export async function updateListing(
  artistId: string,
  listingId: string,
  updates: Partial<CommissionListingPayload>
) {
  // 1. Fetch & auth
  const existing = await findCommissionListingById(listingId);
  if (!existing) throw new HttpError("Listing not found", 404);
  if (existing.artistId.toString() !== artistId) {
    throw new HttpError("Not authorized to update this listing", 403);
  }

  // 2. Sanitize incoming fields
  const sanitized = sanitizePayload(updates);

  // 3. Process payload to ensure all components have IDs, preserving existing IDs where possible
  const processedData = processPayloadWithIds(sanitized);

  // 4. Merge with existing data for a "full payload"
  const merged: Partial<CommissionListingPayload> = {
    ...existing.toObject(),
    ...processedData,
  };

  // 5. Validate the full payload just like on create
  validateListingPayload(merged);

  // 6. Recompute price range
  const price = computePriceRange(merged);
  processedData.price = price;

  console.log("Processed listing data:", processedData);

  // 7. Persist all processed fields (including price!)
  return updateCommissionListingComponents(listingId, processedData);
}

/* ======================================================================
 * Listing Management Operations
 * ====================================================================== */

/**
 * Get all active listings for an artist by ID
 *
 * @param artistId ID of the artist
 * @returns Array of active commission listings
 */
export async function getArtistListings(artistId: string) {
  return findActiveListingsByArtist(artistId);
}

/**
 * Set the active state of a listing (enables/disables it)
 *
 * @param artistId ID of the artist (for auth)
 * @param listingId ID of the listing to update
 * @param active Boolean indicating whether to set listing as active
 * @returns Updated commission listing
 */
export async function setListingActiveState(
  artistId: string,
  listingId: string,
  active: boolean
) {
  // Note: artistId parameter is kept for future authorization checks
  return updateCommissionListing(listingId, { isActive: active });
}

/**
 * Soft delete a listing (marks as deleted but keeps in database)
 *
 * @param artistId ID of the artist who owns the listing
 * @param listingId ID of the listing to delete
 * @returns Result of the delete operation
 */
export async function deleteListing(artistId: string, listingId: string) {
  return softDeleteListing(artistId, listingId);
}

/**
 * Update the slots used in a listing (for order creation/cancellation)
 *
 * @param listingId ID of the listing to update
 * @param delta Number of slots to add/subtract
 * @returns Updated commission listing
 */
export async function applySlotDelta(listingId: string, delta: number) {
  return adjustSlotsUsed(listingId, delta);
}

/**
 * Add a question to a commission listing
 *
 * @param artistId ID of the artist who owns the listing
 * @param listingId ID of the listing to update
 * @param questionText Text of the question to add
 * @param target Where to add the question (general or specific subject)
 * @returns Updated commission listing
 * @throws HttpError if not authorized
 */
export async function addQuestionToListing(
  artistId: string,
  listingId: string,
  questionText: string,
  target: { type: "general" } | { type: "subject"; subjectId: ID }
) {
  // Auth check
  const existing = await findCommissionListingById(listingId);
  if (!existing) throw new HttpError("Listing not found", 404);
  if (existing.artistId.toString() !== artistId) {
    throw new HttpError("Not authorized to update this listing", 403);
  }

  return addQuestion(listingId, questionText, target);
}

/**
 * Remove a question from a commission listing
 *
 * @param artistId ID of the artist who owns the listing
 * @param listingId ID of the listing to update
 * @param target Where to remove the question from (general or specific subject)
 * @returns Updated commission listing
 * @throws HttpError if not authorized
 */
export async function removeQuestionFromListing(
  artistId: string,
  listingId: string,
  target:
    | { type: "general"; questionId: ID }
    | { type: "subject"; subjectId: ID; questionId: ID }
) {
  // Auth check
  const existing = await findCommissionListingById(listingId);
  if (!existing) throw new HttpError("Listing not found", 404);
  if (existing.artistId.toString() !== artistId) {
    throw new HttpError("Not authorized to update this listing", 403);
  }

  return removeQuestion(listingId, target);
}

/* ======================================================================
 * Public Search and Retrieval Operations
 * ====================================================================== */

/**
 * Get active listings for a user by username (public)
 *
 * @param username Username of the artist
 * @returns Array of active commission listings
 * @throws HttpError if user not found
 */
export async function getListingsByUsername(username: string) {
  const artist = await findUserByUsername(username);
  if (!artist) {
    throw new HttpError("User not found", 404);
  }
  return findActiveListingsByArtist(artist._id);
}

/**
 * Get a specific listing by ID (public)
 * Validates that it exists and is active
 *
 * @param listingId ID of the listing to retrieve
 * @returns Commission listing object
 * @throws HttpError if listing not found or not active
 */
export async function getListingPublic(listingId: string) {
  const listing = await findCommissionListingById(listingId, { lean: true });
  if (!listing || listing.isDeleted || !listing.isActive) {
    throw new HttpError("Listing not found", 404);
  }
  return listing;
}

/**
 * Search for listings with basic filtering options
 *
 * @param options Search options including label, tags, artistId, pagination
 * @returns Search results with count and listings
 */
export async function browseListings(options: {
  label?: string;
  tags?: string[];
  artistId?: string;
  skip?: number;
  limit?: number;
}) {
  return searchListings(options);
}

/**
 * Enhanced search for listings with advanced filtering options
 *
 * @param params Advanced search parameters
 * @returns Search results with count and filtered listings
 */
export async function searchCommissionListings(params: {
  label?: string;
  tags?: string[];
  artistId?: string;
  priceRange?: { min?: number; max?: number };
  type?: "template" | "custom";
  flow?: "standard" | "milestone";
  skip?: number;
  limit?: number;
}) {
  return searchListingsEnhanced(params);
}

/**
 * Get bookmarked commission listings with artist information
 *
 * @param commissionIds Array of commission listing IDs
 * @returns Array of commission listings with artist details
 */
export async function getBookmarkedCommissionsWithArtist(
  commissionIds: string[]
) {
  if (!commissionIds.length) return [];

  const objectIds = commissionIds.map((id) => new Types.ObjectId(id));
  return findBookmarkedListingsWithArtist(objectIds);
}