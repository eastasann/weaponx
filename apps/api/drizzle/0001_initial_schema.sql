CREATE TYPE "public"."created_via" AS ENUM('link', 'created', 'copied');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('google_doc', 'google_slides', 'google_sheets', 'pdf', 'other');--> statement-breakpoint
CREATE TYPE "public"."drive_status" AS ENUM('active', 'needs_reauth');--> statement-breakpoint
CREATE TYPE "public"."global_role" AS ENUM('member', 'admin');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('ja', 'en');--> statement-breakpoint
CREATE TYPE "public"."project_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "document_references" (
	"document_id" uuid NOT NULL,
	"referenced_document_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_references_document_id_referenced_document_id_pk" PRIMARY KEY("document_id","referenced_document_id"),
	CONSTRAINT "document_references_not_self" CHECK ("document_references"."document_id" <> "document_references"."referenced_document_id")
);
--> statement-breakpoint
CREATE TABLE "document_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"next_version_no" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_tags" (
	"document_id" uuid NOT NULL,
	"label_key" text NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_tags_document_id_label_key_pk" PRIMARY KEY("document_id","label_key")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"url" text NOT NULL,
	"link_key" text NOT NULL,
	"kind" "document_kind" NOT NULL,
	"google_file_id" text,
	"source_modified_at" timestamp with time zone,
	"metadata_fetched_at" timestamp with time zone,
	"change_note" text,
	"created_via" "created_via" NOT NULL,
	"registered_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_version_no_positive" CHECK ("documents"."version_no" >= 1)
);
--> statement-breakpoint
CREATE TABLE "drive_connections" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"status" "drive_status" NOT NULL,
	"credentials" text NOT NULL,
	"granted_scopes" text[] NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "project_role" NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"google_subject" text,
	"display_name" text,
	"avatar_url" text,
	"global_role" "global_role" DEFAULT 'member' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"locale" "locale",
	"last_login_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "document_references" ADD CONSTRAINT "document_references_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_references" ADD CONSTRAINT "document_references_referenced_document_id_documents_id_fk" FOREIGN KEY ("referenced_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_references" ADD CONSTRAINT "document_references_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_series" ADD CONSTRAINT "document_series_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_series_id_document_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."document_series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_connections" ADD CONSTRAINT "drive_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_references_referenced_idx" ON "document_references" USING btree ("referenced_document_id");--> statement-breakpoint
CREATE INDEX "document_series_project_id_idx" ON "document_series" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_series_version_key" ON "documents" USING btree ("series_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_project_link_key" ON "documents" USING btree ("project_id","link_key") WHERE "documents"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "documents_series_id_idx" ON "documents" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "documents_project_id_idx" ON "documents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "documents_name_key_trgm_idx" ON "documents" USING gin ("name_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "project_members_user_id_idx" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_subject_key" ON "users" USING btree ("google_subject");