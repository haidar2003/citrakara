// src/lib/services/proposal.service.ts

import { Types } from "mongoose";
import { IProposal } from "@/lib/db/models/proposal.model";
import { ICommissionListing } from "../db/models/commissionListing.model";
import { HttpError } from "./commissionListing.service";
import { connectDB } from "@/lib/db/connection";
import { uploadGalleryImagesToR2 } from "@/lib/utils/cloudflare";
import type { Cents, ISODate, ObjectId } from "@/types/common";

import {
  createProposal as repoCreateProposal,
  getProposalById,
  updateProposal as repoUpdateProposal,
  artistResponds,
  clientRespondsToAdjustment,
  findProposalsByUser,
  findProposalsByArtist,
  findProposalsByClient,
  finalizeAcceptance,
  bulkExpirePending,
  computeDynamicEstimate as repoComputeDynamicEstimate,
  ProposalInput,
  ProposalGeneralOptionsInput,
  ProposalSubjectOptionsInput,
  UpdateProposalInput,
  FindOpts,
  ArtistAdjustment,
  cancelProposal,
} from "@/lib/db/repositories/proposal.repository";

import { findCommissionListingById } from "@/lib/db/repositories/commissionListing.repository";

import { getLatestActiveContractDeadline } from "../db/repositories/contract.repository";

/* ======================================================================
 * Service Interfaces
 * ====================================================================== */

export interface ServiceOptionSelection {
  id: number;
  groupId: number;
  selectedSelectionID: number;
  selectedSelectionLabel: string;
  price: Cents;
}

export interface ServiceAddon {
  id: number;
  addonId: number;
  price: Cents;
}

export interface ServiceAnswer {
  id: number;
  questionId: number;
  answer: string;
}

export interface ServiceGeneralOptionsInput {
  optionGroups?: ServiceOptionSelection[];
  addons?: ServiceAddon[];
  answers?: ServiceAnswer[];
}

export interface ServiceSubjectInstance {
  id: number;
  optionGroups?: ServiceOptionSelection[];
  addons?: ServiceAddon[];
  answers?: ServiceAnswer[];
}

export interface ServiceSubjectOption {
  subjectId: number;
  instances: ServiceSubjectInstance[];
}

export interface ServiceSubjectOptionsInput {
  subjects: ServiceSubjectOption[];
}

export interface CreateProposalInput {
  listingId: string;
  earliestDate: Date;
  latestDate: Date;
  deadline: Date;
  generalDescription: string;
  generalOptions?: ServiceGeneralOptionsInput;
  subjectOptions?: ServiceSubjectOptionsInput;
}

export interface UpdateProposalInputService {
  earliestDate?: Date;
  latestDate?: Date;
  deadline?: Date;
  generalDescription?: string;
  generalOptions?: ServiceGeneralOptionsInput;
  subjectOptions?: ServiceSubjectOptionsInput;
}

export interface ArtistDecision {
  acceptProposal: boolean;
  surcharge?: number;
  discount?: number;
  rejectionReason?: string;
}

export interface ClientDecision {
  cancel?: boolean;
  acceptAdjustments?: boolean;
}

export interface ProposalFilters {
  role?: "client" | "artist";
  status?: string[];
  beforeExpire?: boolean;
}

/* ======================================================================
 * Helper Functions
 * ====================================================================== */

/**
 * Convert service general options to repository format
 *
 * @param options The service-level general options
 * @returns Repository-formatted general options or undefined if no options provided
 */
function convertGeneralOptions(
  options?: ServiceGeneralOptionsInput
): ProposalGeneralOptionsInput | undefined {
  if (!options) return undefined;

  const result: ProposalGeneralOptionsInput = {};

  if (options.optionGroups) {
    result.optionGroups = options.optionGroups;
  }

  if (options.addons) {
    result.addons = options.addons;
  }

  if (options.answers) {
    result.answers = options.answers;
  }

  return result;
}

/**
 * Convert service subject options to repository format
 *
 * @param options The service-level subject options
 * @returns Repository-formatted subject options or undefined if no options provided
 */
function convertSubjectOptions(
  options?: ServiceSubjectOptionsInput
): ProposalSubjectOptionsInput[] | undefined {
  if (!options || !options.subjects) return undefined;

  return options.subjects;
}

/**
 * Validate deadline based on listing policy
 *
 * @param listing The commission listing containing deadline policy
 * @param deadline The proposed deadline
 * @param earliestDate The earliest possible start date
 * @param latestDate The latest possible start date
 * @throws HttpError if deadline validation fails
 */
function validateDeadline(
  listing: ICommissionListing,
  deadline: Date,
  earliestDate: Date,
  latestDate: Date
): void {
  switch (listing.deadline.mode) {
    case "standard":
      // For standard mode, deadline is always system-determined as 2 weeks + latestDate
      // Client-provided deadline is ignored
      break;

    case "withDeadline":
      // For withDeadline mode, client-provided deadline must fall on or after earliestDate
      if (deadline < earliestDate) {
        throw new HttpError(
          `Deadline cannot be earlier than ${
            earliestDate.toISOString().split("T")[0]
          }`,
          400
        );
      }
      break;

    case "withRush":
      // For withRush mode, any deadline is valid, but rush fees may apply
      break;

    default:
      throw new HttpError("Invalid deadline mode in listing", 500);
  }
}

/**
 * Validate proposal input before creating or updating
 *
 * @param input The proposal input to validate
 * @throws Error if validation fails
 */
export function validateProposalInput(input: any): void {
  // Validate dates
  if (input.earliestDate >= input.latestDate) {
    throw new Error("Earliest date must be before latest date");
  }

  // Validate description
  if (!input.generalDescription.trim()) {
    throw new Error("Description is required");
  }

  // Validate reference images
  if (input.referenceImages && input.referenceImages.length > 5) {
    throw new Error("Maximum 5 reference images allowed");
  }

  // Validate baseDate is present
  if (!input.baseDate) {
    throw new Error("Base date is required");
  }
}

/* ======================================================================
 * Main CRUD Operations
 * ====================================================================== */

/**
 * Create a proposal from form data
 *
 * @param clientId ID of the client creating the proposal
 * @param form FormData containing proposal details and reference images
 * @returns Created proposal object
 * @throws HttpError if validation fails or creation fails
 */
export async function createProposalFromForm(
  clientId: string,
  form: FormData
): Promise<IProposal> {
  try {
    await connectDB();

    // Parse JSON payload for proposal data
    let jsonPayload: any;
    try {
      const raw = form.get("payload");
      jsonPayload = raw && typeof raw === "string" ? JSON.parse(raw) : {};
    } catch {
      throw new HttpError("Invalid JSON payload", 400);
    }

    // Validate required fields
    const listingId = form.get("listingId");
    if (!listingId || typeof listingId !== "string") {
      throw new HttpError("Required field missing: listingId", 400);
    }

    // Fetch and validate listing
    const listing = await findCommissionListingById(listingId);
    if (!listing) {
      throw new HttpError("Listing not found", 404);
    }

    if (!listing.isActive || listing.isDeleted) {
      throw new HttpError("Listing is not active", 400);
    }

    // Get the baseDate (latest contract deadline or current date)
    const baseDate =
      (await getLatestActiveContractDeadline(listing.artistId)) || new Date();

    // Get dynamic availability window to tackle race conditions
    const { earliestDate, latestDate } = await repoComputeDynamicEstimate(
      listing,
      baseDate
    );

    // Extract deadline from form
    const deadlineFromForm = form.get("deadline");
    if (!deadlineFromForm) {
      throw new HttpError("Missing required deadline field", 400);
    }

    const deadline = new Date(deadlineFromForm.toString());

    // Validate deadline based on listing deadline policy
    validateDeadline(listing, deadline, earliestDate, latestDate);

    // Extract general description
    const generalDescription = form.get("generalDescription");
    if (!generalDescription || typeof generalDescription !== "string") {
      throw new HttpError("Missing required general description", 400);
    }

    // Process reference image uploads
    const referenceBlobs: Blob[] = [];
    form.forEach((value, key) => {
      if (key === "referenceImages[]" && value instanceof Blob) {
        referenceBlobs.push(value);
      }
    });

    // Upload reference images to R2
    const referenceImages = await uploadGalleryImagesToR2(
      referenceBlobs,
      clientId,
      "proposal"
    );

    // Extract options from JSON payload
    const { generalOptions, subjectOptions } = jsonPayload;

    // Convert service options format to repository format
    const repoGeneralOptions = convertGeneralOptions(generalOptions);
    const repoSubjectOptions = convertSubjectOptions(subjectOptions);

    // Create proposal input for repository
    const proposalInput: ProposalInput = {
      clientId,
      artistId: listing.artistId.toString(),
      listingId,
      earliestDate,
      latestDate,
      deadline,
      baseDate, // Include baseDate in proposal creation
      generalDescription: generalDescription.toString(),
      referenceImages,
      generalOptions: repoGeneralOptions,
      subjectOptions: repoSubjectOptions,
    };

    validateProposalInput(proposalInput); // Validate input before creating

    // console.log(proposalInput, JSON.stringify(proposalInput))

    return repoCreateProposal(proposalInput);
  } catch (error) {
    console.error("Error creating proposal:", error);
    throw error;
  }
}

/**
 * Update a proposal from form data
 *
 * @param proposalId ID of the proposal to update
 * @param userId ID of the user updating the proposal
 * @param form FormData containing updated proposal details
 * @returns Updated proposal object
 * @throws HttpError if validation fails or update fails
 */
export async function updateProposalFromForm(
  proposalId: string,
  userId: string,
  form: FormData
): Promise<IProposal> {
  try {
    await connectDB();

    // First check if proposal exists and user has permission to edit
    const existing = await getProposalById(proposalId);
    if (!existing) {
      throw new HttpError("Proposal not found", 404);
    }

    if (existing.clientId.toString() !== userId) {
      throw new HttpError("Not authorized to edit this proposal", 403);
    }

    if (existing.status !== "pendingArtist") {
      throw new HttpError(
        "Can only edit proposals in pendingArtist status",
        400
      );
    }

    // Parse JSON payload
    let jsonPayload: any;
    try {
      const raw = form.get("payload");
      jsonPayload = raw && typeof raw === "string" ? JSON.parse(raw) : {};
    } catch {
      throw new HttpError("Invalid JSON payload", 400);
    }

    // Fetch the listing to validate deadline against policy
    const listing = await findCommissionListingById(
      existing.listingId.toString()
    );
    if (!listing) {
      throw new HttpError("Associated listing not found", 404);
    }

    // Get the baseDate (latest contract deadline or current date)
    const baseDate =
      (await getLatestActiveContractDeadline(listing.artistId)) || new Date();

    // Get dynamic availability window
    const { earliestDate, latestDate } = await repoComputeDynamicEstimate(
      listing,
      baseDate
    );

    // Initialize updates object
    const updates: UpdateProposalInput = {
      earliestDate,
      latestDate,
      baseDate, // Include updated baseDate
    };

    // Handle deadline update if provided
    const deadlineFromForm = form.get("deadline");
    if (deadlineFromForm) {
      const deadline = new Date(deadlineFromForm.toString());

      // Validate deadline based on listing deadline policy
      validateDeadline(listing, deadline, earliestDate, latestDate);

      updates.deadline = deadline;
    }

    // Handle general description if provided
    const generalDescription = form.get("generalDescription");
    if (generalDescription && typeof generalDescription === "string") {
      updates.generalDescription = generalDescription;
    }

    // Extract options from JSON payload
    if (jsonPayload.generalOptions) {
      updates.generalOptions = convertGeneralOptions(
        jsonPayload.generalOptions
      );
    }

    if (jsonPayload.subjectOptions) {
      updates.subjectOptions = convertSubjectOptions(
        jsonPayload.subjectOptions
      );
    }

    // Handle reference images: combine existing kept images with new uploads
    const existingReferences = form
      .getAll("existingReferences[]")
      .map((v) => v.toString());

    const referenceBlobs = form
      .getAll("referenceImages[]")
      .filter((v) => v instanceof Blob) as Blob[];

    // Only process images if either existing or new files were submitted
    if (existingReferences.length > 0 || referenceBlobs.length > 0) {
      // Upload new reference images (if any)
      let uploadedUrls: string[] = [];
      if (referenceBlobs.length > 0) {
        uploadedUrls = await uploadGalleryImagesToR2(
          referenceBlobs,
          userId,
          "proposal"
        );
      }

      // Combine existing and new references
      updates.referenceImages = [...existingReferences, ...uploadedUrls];
    }

    const updatedProposal = await repoUpdateProposal(proposalId, updates);
    if (!updatedProposal) {
      throw new HttpError("Failed to update proposal", 500);
    }

    return updatedProposal;
  } catch (error) {
    console.error("Error updating proposal:", error);
    throw error;
  }
}

/* ======================================================================
 * Response Operations
 * ====================================================================== */

/**
 * Handle artist response to a proposal
 *
 * @param artistId ID of the artist responding to the proposal
 * @param proposalId ID of the proposal to respond to
 * @param decision Artist decision (accept/reject with optional adjustments)
 * @returns Updated proposal object
 * @throws Error if validation fails or response fails
 */
export async function artistRespond(
  artistId: string,
  proposalId: string,
  decision: ArtistDecision
): Promise<IProposal> {
  try {
    await connectDB();

    console.log({
      artistId,
      proposalId,
      decision,
    });

    const proposal = await getProposalById(proposalId);
    if (!proposal) {
      throw new Error("Proposal not found");
    }

    console.log(proposal.status);

    if (proposal.artistId.toString() !== artistId) {
      throw new Error("Not authorized to respond to this proposal");
    }

    // Artist is rejecting the proposal
    if (!decision.acceptProposal) {
      if (!decision.rejectionReason) {
        throw new Error("Rejection reason is required");
      }
      return artistResponds(
        proposalId,
        false,
        undefined,
        decision.rejectionReason
      );
    }

    if (
      proposal.status == "pendingArtist" ||
      proposal.status == "rejectedClient"
    ) {
      // Artist is accepting, check if there are adjustments
      let adjustment: ArtistAdjustment | undefined;
      if (decision.surcharge || decision.discount) {
        adjustment = {
          proposedSurcharge: decision.surcharge,
          proposedDiscount: decision.discount,
          proposedDate: new Date(),
        };
      }

      return artistResponds(proposalId, true, adjustment, undefined);
    } else {
      throw new Error("Proposal is not awaiting artist response");
    }
  } catch (error) {
    console.error("Error in artist response:", error);
    throw error;
  }
}

/**
 * Handle client response to a proposal
 *
 * @param clientId ID of the client responding to the proposal
 * @param proposalId ID of the proposal to respond to
 * @param decision Client decision (accept adjustments or cancel)
 * @returns Updated proposal object
 * @throws Error if validation fails or response fails
 */
export async function clientRespond(
  clientId: string,
  proposalId: string,
  decision: ClientDecision
): Promise<IProposal> {
  try {
    await connectDB();

    const proposal = await getProposalById(proposalId);
    if (!proposal) {
      throw new Error("Proposal not found");
    }

    if (proposal.clientId.toString() !== clientId) {
      throw new Error("Not authorized to respond to this proposal");
    }

    // Handle cancellation (can happen at any status)
    if (decision.cancel) {
      return cancelProposal(proposalId, clientId);
    }

    // Regular client response to adjustment
    if (proposal.status !== "pendingClient") {
      throw new Error("Proposal is not awaiting client response");
    }

    return clientRespondsToAdjustment(
      proposalId,
      decision.acceptAdjustments,
      false // Not canceling
    );
  } catch (error) {
    console.error("Error in client response:", error);
    throw error;
  }
}

/* ======================================================================
 * Query Operations
 * ====================================================================== */

/**
 * Get proposals for a user based on role and filters
 *
 * @param userId ID of the user
 * @param role Role of the user (client or artist)
 * @param filters Optional filters for proposal status and expiration
 * @returns Array of proposals matching the criteria
 * @throws Error if the query fails
 */
export async function getUserProposals(
  userId: string,
  role: "client" | "artist",
  filters?: ProposalFilters
): Promise<IProposal[]> {
  try {
    await connectDB();

    const options: FindOpts = {
      status: filters?.status,
      beforeExpire: filters?.beforeExpire,
    };

    return findProposalsByUser(userId, role, options);
  } catch (error) {
    console.error("Error fetching user proposals:", error);
    throw error;
  }
}

/**
 * Get incoming proposals for an artist
 *
 * @param artistId ID of the artist
 * @param filters Optional filters for proposal status and expiration
 * @returns Array of incoming proposals
 * @throws Error if the query fails
 */
export async function getIncomingProposals(
  artistId: string,
  filters?: ProposalFilters
): Promise<IProposal[]> {
  try {
    await connectDB();

    return findProposalsByArtist(artistId);
  } catch (error) {
    console.error("Error fetching incoming proposals:", error);
    throw error;
  }
}

/**
 * Get outgoing proposals for a client
 *
 * @param clientId ID of the client
 * @param filters Optional filters for proposal status and expiration
 * @returns Array of outgoing proposals
 * @throws Error if the query fails
 */
export async function getOutgoingProposals(
  clientId: string,
  filters?: ProposalFilters
): Promise<IProposal[]> {
  try {
    await connectDB();

    const options: FindOpts = {
      status: filters?.status,
    };

    return findProposalsByClient(clientId, options);
  } catch (error) {
    console.error("Error fetching outgoing proposals:", error);
    throw error;
  }
}

/**
 * Fetch a specific proposal by ID with permission check
 *
 * @param proposalId ID of the proposal to fetch
 * @param userId ID of the user requesting the proposal
 * @returns Proposal object if authorized
 * @throws Error if not found or not authorized
 */
export async function fetchProposalById(
  proposalId: string,
  userId: string
): Promise<IProposal> {
  try {
    await connectDB();

    const proposal = await getProposalById(proposalId);
    if (!proposal) {
      throw new Error("Proposal not found");
    }

    // Check if user has permission to view
    const isClient = proposal.clientId.toString() === userId;
    const isArtist = proposal.artistId.toString() === userId;

    if (!isClient && !isArtist) {
      throw new Error("Not authorized to view this proposal");
    }

    return proposal;
  } catch (error) {
    console.error("Error fetching proposal:", error);
    throw error;
  }
}

/* ======================================================================
 * Permission Helpers
 * ====================================================================== */

/**
 * Check if a user can edit a proposal
 *
 * @param proposalId ID of the proposal to check
 * @param userId ID of the user attempting to edit
 * @returns Boolean indicating whether user can edit
 */
export async function canEditProposal(
  proposalId: string,
  userId: string
): Promise<boolean> {
  try {
    const proposal = await getProposalById(proposalId);
    if (!proposal) return false;

    return (
      proposal.clientId.toString() === userId &&
      proposal.status === "pendingArtist"
    );
  } catch (error) {
    console.error("Error checking edit permission:", error);
    return false;
  }
}

/**
 * Check if a user can respond to a proposal
 *
 * @param proposalId ID of the proposal to check
 * @param userId ID of the user attempting to respond
 * @param role Role of the user (client or artist)
 * @returns Boolean indicating whether user can respond
 */
export async function canRespondToProposal(
  proposalId: string,
  userId: string,
  role: "client" | "artist"
): Promise<boolean> {
  try {
    const proposal = await getProposalById(proposalId);
    if (!proposal) return false;

    if (role === "artist") {
      return (
        proposal.artistId.toString() === userId &&
        proposal.status === "pendingArtist"
      );
    } else {
      return (
        proposal.clientId.toString() === userId &&
        proposal.status === "pendingClient"
      );
    }
  } catch (error) {
    console.error("Error checking respond permission:", error);
    return false;
  }
}

/* ======================================================================
 * Status Operations
 * ====================================================================== */

/**
 * Finalize an accepted proposal
 *
 * @param proposalId ID of the proposal to finalize
 * @returns Finalized proposal object
 * @throws Error if proposal not found or not in accepted status
 */
export async function finalizeProposal(proposalId: string): Promise<IProposal> {
  try {
    await connectDB();

    const proposal = await getProposalById(proposalId);
    if (!proposal) {
      throw new Error("Proposal not found");
    }

    if (proposal.status !== "accepted") {
      throw new Error("Proposal must be in accepted status to finalize");
    }

    return finalizeAcceptance(proposalId);
  } catch (error) {
    console.error("Error finalizing proposal:", error);
    throw error;
  }
}

/**
 * Expire old pending proposals
 *
 * @param asOf Date to check expiration against (defaults to current date)
 * @returns Number of expired proposals
 * @throws Error if operation fails
 */
export async function expireOldProposals(
  asOf: Date = new Date()
): Promise<number> {
  try {
    await connectDB();
    return bulkExpirePending(asOf);
  } catch (error) {
    console.error("Error expiring proposals:", error);
    throw error;
  }
}

/* ======================================================================
 * Dashboard Helpers
 * ====================================================================== */

/**
 * Get dashboard data for a user showing incoming and outgoing proposals
 *
 * @param userId ID of the user
 * @returns Object containing incoming and outgoing proposals with counts
 * @throws Error if data fetching fails
 */
export async function getDashboardData(userId: string): Promise<{
  incoming: IProposal[];
  outgoing: IProposal[];
  totalIncoming: number;
  totalOutgoing: number;
}> {
  try {
    await connectDB();

    const [incoming, outgoing] = await Promise.all([
      getIncomingProposals(userId),
      getOutgoingProposals(userId),
    ]);

    return {
      incoming,
      outgoing,
      totalIncoming: incoming.length,
      totalOutgoing: outgoing.length,
    };
  } catch (error) {
    console.error("Error fetching dashboard data:", error);
    throw error;
  }
}

/* ======================================================================
 * Utility Operations
 * ====================================================================== */

/**
 * Get dynamic estimate for start and end dates based on listing
 *
 * @param listingId ID of the commission listing
 * @returns Object with earliest date, latest date, and base date
 * @throws Error if listing not found
 */
export async function getDynamicEstimate(listingId: string) {
  await connectDB();
  const listing = await findCommissionListingById(listingId);
  if (!listing) throw new Error("Listing not found");

  // Get the artist's latest active contract deadline
  const latestDeadline = await getLatestActiveContractDeadline(
    listing.artistId
  );

  const baseDate = latestDeadline ?? new Date(); // now if none
  return {
    ...repoComputeDynamicEstimate(listing, baseDate),
    baseDate, // Also return baseDate for context
  };
}