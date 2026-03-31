import { mergeSchemas } from "@graphql-tools/schema";
import { gql } from "@keystone-6/core/admin-ui/apollo";
import axios from "axios";

const GEMINI_API_URL =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

const API_Key = process.env.GEMINI_API_KEY;

export const extendGraphqlSchema = (schema: any) =>
    mergeSchemas({
        schemas: [schema],

        typeDefs: gql`
      type RegisterResponse {
        user: User
      }

      type LoginResponse {
        user: User
      }

      type PodcastRecommendation {
        id: ID!
        title: String!
        category: String
        video_url: String
        audio_url: String
        artwork: String
        lyricist: String
        type: String!
        artist: ArtistInfo
        isFavorite: Boolean!
      }

      type ArtistInfo {
        id: ID!
        name: String!
        bio: String
        photo: String
      }

      extend type Mutation {
        registerUser(
          name: String!
          email: String!
          password: String!
          confirmPassword: String!
        ): RegisterResponse

        loginUser(
          email: String!
          password: String!
        ): LoginResponse
      }

      extend type Query {
        getRecommendedPodcasts(userId: ID!): [PodcastRecommendation]
      }
    `,

        resolvers: {
            Mutation: {
                // ==========================
                // REGISTER USER
                // ==========================
                registerUser: async (
                    _,
                    { name, email, password, confirmPassword },
                    context
                ) => {
                    if (!name || !email || !password || !confirmPassword) {
                        throw new Error("All fields are required");
                    }

                    if (password !== confirmPassword) {
                        throw new Error("Password and confirm password do not match");
                    }

                    const existingUser = await context.db.User.findOne({
                        where: { email },
                    });

                    if (existingUser) {
                        throw new Error("User already exists with this email");
                    }

                    const newUser = await context.db.User.createOne({
                        data: { name, email, password },
                    });

                    return { user: newUser };
                },

                // ==========================
                // LOGIN USER
                // ==========================
                loginUser: async (_, { email, password }, context) => {
                    // 1️⃣ Required validation
                    if (!email || !password) {
                        throw new Error("Email and password are required");
                    }

                    // 2️⃣ Find user by email
                    const user = await context.db.User.findOne({
                        where: { email },
                    });

                    if (!user) {
                        throw new Error("Invalid email or password");
                    }

                    // 3️⃣ Password validation (Keystone password field)
                    const validUser = await context.db.User.findOne({
                        where: { email, password },
                    });

                    if (!validUser) {
                        throw new Error("Invalid email or password");
                    }

                    return { user };
                },
            },

            Query: {
                // ==========================
                // AI PODCAST RECOMMENDATION
                // ==========================
                getRecommendedPodcasts: async (_, { userId }, context) => {
                    try {
                        console.log("Fetching recommendations for user ID:", userId);

                        // 1. Fetch User and their interests
                        const user = await context.query.User.findOne({
                            where: { id: userId },
                            query: "id favoritePodcasts { id title category }",
                        });

                        if (!user) throw new Error("User not found");

                        const favoritePodcasts = user.favoritePodcasts || [];
                        const favCategories = [...new Set(favoritePodcasts.map((p) => p.category))];

                        // 2. Fetch available podcasts to recommend from
                        const allPodcast = await context.query.Podcast.findMany({
                            query: `
                id title category video_url audio_url type artwork lyricist
                artist { id name bio photo }
            `,
                        });

                        const favoritePodcastIds = favoritePodcasts.map((p) => p.id);
                        const availablePodcast = allPodcast.filter(
                            (p) => !favoritePodcastIds.includes(p.id)
                        );

                        if (!availablePodcast.length) return [];

                        // 3. Construct a clear prompt for the 2.5/3.1 models
                        const prompt = `
            You are a podcast recommendation engine. 
            User interests: ${favCategories.join(", ") || "General"}.
            
            Task: Pick exactly 3 podcasts from the list below that match these interests.
            List:
            ${availablePodcast.map(p => `- ${p.title} (Category: ${p.category})`).join("\n")}

            Return ONLY a JSON object with this key: "recommendation" containing an array of titles.
        `;

                        // 4. Call Gemini with JSON Mode enabled
                        const response = await axios.post(
                            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
                            {
                                contents: [{ parts: [{ text: prompt }] }],
                                generationConfig: {
                                    responseMimeType: "application/json", // Forces raw JSON output
                                }
                            },
                            { headers: { "Content-Type": "application/json" } }
                        );

                        // 5. Direct Parsing (No regex needed because of responseMimeType)
                        const apiResponseText = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
                        if (!apiResponseText) throw new Error("Empty AI response");

                        const parsedData = JSON.parse(apiResponseText);
                        const recommendationTitles = parsedData.recommendation;

                        if (!Array.isArray(recommendationTitles)) {
                            throw new Error("Invalid recommendation format from AI");
                        }

                        // 6. Map titles back to full Podcast objects
                        return allPodcast.filter((p) => recommendationTitles.includes(p.title))
                            

                    } catch (error) {
                        // Detailed logging for debugging
                        console.error("AI Podcast Recommendation Error:", error?.response?.data || error?.message);
                        throw new Error("Failed to get podcast recommendations");
                    }
                }
            },
        },
    });
