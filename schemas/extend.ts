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
                        const user = await context.db.User.findOne({
                            where: { id: userId },
                            query: "id favoritePodcasts { id title category }",
                        });

                        if (!user) {
                            throw new Error("User not found");
                        }

                        const favoritePodcasts = user.favoritePodcasts || [];
                        const favCategories = [
                            ...new Set(favoritePodcasts.map((p: any) => p.category)),
                        ];

                        const allPodcast = await context.db.Podcast.findMany({
                            query: `
                id
                title
                category
                video_url
                audio_url
                type
                artwork
                lyricist
                artist {
                  id
                  name
                  bio
                  photo
                }
              `,
                        });

                        const favoritePodcastIds = favoritePodcasts.map((p: any) => p.id);
                        const availablePodcast = allPodcast.filter(
                            (p: any) => !favoritePodcastIds.includes(p.id)
                        );

                        if (!availablePodcast.length) return [];

                        const prompt = `
You are an AI podcast recommendation system.
The user listens to these categories: ${favCategories.length ? favCategories.join(", ") : "None"
                            }.

From the following podcasts, recommend 3:
${availablePodcast
                                .map(
                                    (p: any) =>
                                        `${p.title} (Category: ${p.category}, Artist: ${p.artist?.name})`
                                )
                                .join("\n")}

Return JSON only:
{
  "recommendation": ["Title 1", "Title 2", "Title 3"]
}
`;

                        const response = await axios.post(
                            `${GEMINI_API_URL}?key=${API_Key}`,
                            {
                                contents: [{ parts: [{ text: prompt }] }],
                            },
                            { headers: { "Content-Type": "application/json" } }
                        );

                        const apiText =
                            response.data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

                        const jsonMatch = apiText.match(/```json\n([\s\S]*?)\n```/);
                        if (!jsonMatch) throw new Error("Invalid AI response");

                        const { recommendation } = JSON.parse(jsonMatch[1]);
                        if (!Array.isArray(recommendation)) {
                            throw new Error("Invalid recommendation format");
                        }

                        return allPodcast
                            .filter((p: any) => recommendation.includes(p.title))
                            .map((p: any) => ({
                                ...p,
                                artist: {
                                    id: "AI",
                                    name: "AI Generated",
                                    bio: "AI generated based on your interests",
                                    photo:
                                        "https://blog.udemy.com/wp-content/uploads/2020/11/2HoneSkills-620x414.jpg",
                                },
                            }));
                    } catch (error) {
                        console.error("AI Podcast Recommendation Error:", error);
                        throw new Error("Failed to get podcast recommendations");
                    }
                },
            },
        },
    });
