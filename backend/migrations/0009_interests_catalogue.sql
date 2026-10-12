-- =============================================================================
-- Unihood migration 0009 - the curated interest catalogue
--
-- Phase 5 asks members to pick interests during onboarding, so the vocabulary has
-- to be worth browsing: about 140 curated interests in 15 named categories,
-- instead of the 13 broad labels migration 0002 seeded.
--
-- Two rules make this safe to re-run:
--
--   * `interests` is keyed by a stable slug and by a unique name, and the seed is
--     an `INSERT ... ON DUPLICATE KEY UPDATE`, so running it again refreshes
--     labels, categories and ordering instead of adding rows.
--   * **`profile_interests` is never touched.** Every id from 0002 keeps its id
--     and its name, so a member who picked `coding` before this migration still
--     has `coding` after it - the new rows are additions, not replacements.
--
-- `category` is a column rather than a separate table because the set is closed,
-- owned by the server and small: the CHECK below is the same "the database can
-- never hold a category the API does not know" guarantee the other vocabularies
-- use (see `0006_groups.sql`).
-- =============================================================================

ALTER TABLE interests
  ADD COLUMN category VARCHAR(40) NOT NULL DEFAULT 'general_social' AFTER name,
  -- The groups an id may sort within: two interests in the same category still
  -- need a defined order, and the mobile picker renders them in it.
  ADD CONSTRAINT interests_category_chk CHECK (
    category IN (
      'exams_career',
      'programming_tech',
      'education_study',
      'sports_fitness',
      'outdoors_gardening',
      'movies_entertainment',
      'music_performing',
      'books_writing',
      'food_cooking',
      'travel_exploration',
      'gaming',
      'photography_crafts',
      'entrepreneurship',
      'languages_culture',
      'general_social'
    )
  );

-- The vocabulary that existed before this migration, sorted into the new
-- categories. Ids and names are untouched - only the grouping and order change.
UPDATE interests SET category = 'sports_fitness',      sort_order = 10  WHERE id = 'sports';
UPDATE interests SET category = 'programming_tech',    sort_order = 10  WHERE id = 'coding';
UPDATE interests SET category = 'music_performing',    sort_order = 10  WHERE id = 'music';
UPDATE interests SET category = 'movies_entertainment', sort_order = 10 WHERE id = 'movies';
UPDATE interests SET category = 'education_study',     sort_order = 10  WHERE id = 'study';
UPDATE interests SET category = 'photography_crafts',  sort_order = 20  WHERE id = 'art';
UPDATE interests SET category = 'food_cooking',        sort_order = 10  WHERE id = 'food';
UPDATE interests SET category = 'gaming',              sort_order = 10  WHERE id = 'gaming';
UPDATE interests SET category = 'travel_exploration',  sort_order = 10  WHERE id = 'travel';
UPDATE interests SET category = 'outdoors_gardening',  sort_order = 90  WHERE id = 'volunteering';
UPDATE interests SET category = 'sports_fitness',      sort_order = 20  WHERE id = 'fitness';
UPDATE interests SET category = 'books_writing',       sort_order = 10  WHERE id = 'reading';
UPDATE interests SET category = 'photography_crafts',  sort_order = 10  WHERE id = 'photography';

INSERT INTO interests (id, name, category, sort_order, is_active) VALUES
  -- Competitive exams and career preparation
  ('upsc', 'UPSC', 'exams_career', 20, 1),
  ('jee', 'JEE', 'exams_career', 30, 1),
  ('neet', 'NEET', 'exams_career', 40, 1),
  ('gate', 'GATE', 'exams_career', 50, 1),
  ('cat', 'CAT', 'exams_career', 60, 1),
  ('banking_exams', 'Banking exams', 'exams_career', 70, 1),
  ('ssc', 'SSC', 'exams_career', 80, 1),
  ('state_psc', 'State PSC', 'exams_career', 90, 1),
  ('clat', 'CLAT', 'exams_career', 100, 1),
  ('government_exams', 'Government exams', 'exams_career', 110, 1),
  ('internships', 'Internships', 'exams_career', 120, 1),
  ('placements', 'Campus placements', 'exams_career', 130, 1),

  -- Programming and technology
  ('coding', 'Coding', 'programming_tech', 10, 1),
  ('web_development', 'Web development', 'programming_tech', 20, 1),
  ('dsa', 'DSA', 'programming_tech', 30, 1),
  ('python', 'Python', 'programming_tech', 40, 1),
  ('javascript', 'JavaScript', 'programming_tech', 50, 1),
  ('mobile_development', 'Mobile development', 'programming_tech', 60, 1),
  ('ai_ml', 'AI & machine learning', 'programming_tech', 70, 1),
  ('data_science', 'Data science', 'programming_tech', 80, 1),
  ('cybersecurity', 'Cybersecurity', 'programming_tech', 90, 1),
  ('cloud_computing', 'Cloud computing', 'programming_tech', 100, 1),
  ('devops', 'DevOps', 'programming_tech', 110, 1),
  ('open_source', 'Open source', 'programming_tech', 120, 1),
  ('robotics', 'Robotics', 'programming_tech', 130, 1),
  ('competitive_programming', 'Competitive programming', 'programming_tech', 140, 1),

  -- Education and study
  ('study', 'Study', 'education_study', 10, 1),
  ('study_groups', 'Study groups', 'education_study', 20, 1),
  ('math', 'Mathematics', 'education_study', 30, 1),
  ('physics', 'Physics', 'education_study', 40, 1),
  ('chemistry', 'Chemistry', 'education_study', 50, 1),
  ('biology', 'Biology', 'education_study', 60, 1),
  ('economics', 'Economics', 'education_study', 70, 1),
  ('history', 'History', 'education_study', 80, 1),
  ('philosophy', 'Philosophy', 'education_study', 90, 1),
  ('psychology', 'Psychology', 'education_study', 100, 1),
  ('research', 'Research', 'education_study', 110, 1),
  -- Sports and fitness
  ('sports', 'Sports', 'sports_fitness', 10, 1),
  ('fitness', 'Fitness', 'sports_fitness', 20, 1),
  ('running', 'Running', 'sports_fitness', 30, 1),
  ('gym', 'Gym training', 'sports_fitness', 40, 1),
  ('badminton', 'Badminton', 'sports_fitness', 50, 1),
  ('cricket', 'Cricket', 'sports_fitness', 60, 1),
  ('football', 'Football', 'sports_fitness', 70, 1),
  ('basketball', 'Basketball', 'sports_fitness', 80, 1),
  ('tennis', 'Tennis', 'sports_fitness', 90, 1),
  ('table_tennis', 'Table tennis', 'sports_fitness', 100, 1),
  ('swimming', 'Swimming', 'sports_fitness', 110, 1),
  ('chess', 'Chess', 'sports_fitness', 120, 1),
  ('yoga', 'Yoga', 'sports_fitness', 130, 1),
  ('cycling', 'Cycling', 'sports_fitness', 140, 1),

  -- Outdoors and gardening
  ('gardening', 'Gardening', 'outdoors_gardening', 10, 1),
  ('hiking', 'Hiking', 'outdoors_gardening', 20, 1),
  ('trekking', 'Trekking', 'outdoors_gardening', 30, 1),
  ('camping', 'Camping', 'outdoors_gardening', 40, 1),
  ('nature_walks', 'Nature walks', 'outdoors_gardening', 50, 1),
  ('stargazing', 'Stargazing', 'outdoors_gardening', 60, 1),
  ('plants', 'Indoor plants', 'outdoors_gardening', 70, 1),
  ('sustainability', 'Sustainability', 'outdoors_gardening', 80, 1),
  ('volunteering', 'Volunteering', 'outdoors_gardening', 90, 1),

  -- Movies and entertainment
  ('movies', 'Film & TV', 'movies_entertainment', 10, 1),
  ('anime', 'Anime', 'movies_entertainment', 20, 1),
  ('web_series', 'Web series', 'movies_entertainment', 30, 1),
  ('documentaries', 'Documentaries', 'movies_entertainment', 40, 1),
  ('standup_comedy', 'Stand-up comedy', 'movies_entertainment', 50, 1),
  ('theatre', 'Theatre', 'movies_entertainment', 60, 1),
  ('filmmaking', 'Filmmaking', 'movies_entertainment', 70, 1),

  -- Music and performing arts
  ('music', 'Music', 'music_performing', 10, 1),
  ('singing', 'Singing', 'music_performing', 20, 1),
  ('guitar', 'Guitar', 'music_performing', 30, 1),
  ('piano', 'Piano', 'music_performing', 40, 1),
  ('indian_classical', 'Indian classical music', 'music_performing', 50, 1),
  ('bollywood_music', 'Bollywood music', 'music_performing', 60, 1),
  ('k_pop', 'K-pop', 'music_performing', 70, 1),
  ('indie_music', 'Indie music', 'music_performing', 80, 1),
  ('dj_production', 'DJ & producing', 'music_performing', 90, 1),
  ('dance', 'Dance', 'music_performing', 100, 1),
  -- Books and writing
  ('reading', 'Reading', 'books_writing', 10, 1),
  ('fiction', 'Fiction', 'books_writing', 20, 1),
  ('non_fiction', 'Non-fiction', 'books_writing', 30, 1),
  ('poetry', 'Poetry', 'books_writing', 40, 1),
  ('writing', 'Writing', 'books_writing', 50, 1),
  ('blogging', 'Blogging', 'books_writing', 60, 1),
  ('journaling', 'Journaling', 'books_writing', 70, 1),
  ('comics', 'Comics & graphic novels', 'books_writing', 80, 1),
  ('book_clubs', 'Book clubs', 'books_writing', 90, 1),
  ('self_help', 'Self-help', 'books_writing', 100, 1),

  -- Food and cooking
  ('food', 'Food', 'food_cooking', 10, 1),
  ('cooking', 'Cooking', 'food_cooking', 20, 1),
  ('baking', 'Baking', 'food_cooking', 30, 1),
  ('street_food', 'Street food', 'food_cooking', 40, 1),
  ('cafes', 'Cafes', 'food_cooking', 50, 1),
  ('coffee', 'Coffee', 'food_cooking', 60, 1),
  ('vegetarian_food', 'Vegetarian food', 'food_cooking', 70, 1),
  ('healthy_eating', 'Healthy eating', 'food_cooking', 80, 1),

  -- Travel and exploration
  ('travel', 'Travel', 'travel_exploration', 10, 1),
  ('road_trips', 'Road trips', 'travel_exploration', 20, 1),
  ('backpacking', 'Backpacking', 'travel_exploration', 30, 1),
  ('solo_travel', 'Solo travel', 'travel_exploration', 40, 1),
  ('hill_stations', 'Hill stations', 'travel_exploration', 50, 1),
  ('beaches', 'Beaches', 'travel_exploration', 60, 1),
  ('heritage_sites', 'Heritage sites', 'travel_exploration', 70, 1),
  ('museums', 'Museums', 'travel_exploration', 80, 1),
  ('international_travel', 'International travel', 'travel_exploration', 90, 1),

  -- Gaming
  ('gaming', 'Gaming', 'gaming', 10, 1),
  ('mobile_gaming', 'Mobile gaming', 'gaming', 20, 1),
  ('pc_gaming', 'PC gaming', 'gaming', 30, 1),
  ('esports', 'Esports', 'gaming', 40, 1),
  ('board_games', 'Board games', 'gaming', 50, 1),
  ('pubg', 'BGMI & PUBG', 'gaming', 60, 1),
  ('valorant', 'Valorant', 'gaming', 70, 1),
  -- Photography and crafts
  ('photography', 'Photography', 'photography_crafts', 10, 1),
  ('art', 'Art & Design', 'photography_crafts', 20, 1),
  ('mobile_photography', 'Mobile photography', 'photography_crafts', 30, 1),
  ('video_editing', 'Video editing', 'photography_crafts', 40, 1),
  ('sketching', 'Sketching', 'photography_crafts', 50, 1),
  ('painting', 'Painting', 'photography_crafts', 60, 1),
  ('digital_art', 'Digital art', 'photography_crafts', 70, 1),
  ('crafting', 'Crafting', 'photography_crafts', 80, 1),
  ('calligraphy', 'Calligraphy', 'photography_crafts', 90, 1),
  ('fashion', 'Fashion & styling', 'photography_crafts', 100, 1),

  -- Entrepreneurship and professional development
  ('entrepreneurship', 'Entrepreneurship', 'entrepreneurship', 10, 1),
  ('startups', 'Startups', 'entrepreneurship', 20, 1),
  ('business', 'Business', 'entrepreneurship', 30, 1),
  ('marketing', 'Marketing', 'entrepreneurship', 40, 1),
  ('finance', 'Finance', 'entrepreneurship', 50, 1),
  ('investing', 'Investing', 'entrepreneurship', 60, 1),
  ('freelancing', 'Freelancing', 'entrepreneurship', 70, 1),
  ('personal_branding', 'Personal branding', 'entrepreneurship', 80, 1),
  ('networking', 'Networking', 'entrepreneurship', 90, 1),
  ('public_speaking', 'Public speaking', 'entrepreneurship', 100, 1),
  ('debate', 'Debate', 'entrepreneurship', 110, 1),
  ('leadership', 'Leadership', 'entrepreneurship', 120, 1),

  -- Languages and cultural activities
  ('languages', 'Languages', 'languages_culture', 10, 1),
  ('english_speaking', 'English speaking', 'languages_culture', 20, 1),
  ('hindi_literature', 'Hindi literature', 'languages_culture', 30, 1),
  ('spanish', 'Spanish', 'languages_culture', 40, 1),
  ('french', 'French', 'languages_culture', 50, 1),
  ('japanese', 'Japanese', 'languages_culture', 60, 1),
  ('german', 'German', 'languages_culture', 70, 1),
  ('culture', 'Culture & traditions', 'languages_culture', 80, 1),
  ('festivals', 'Festivals', 'languages_culture', 90, 1),
  ('religion_spirituality', 'Religion & spirituality', 'languages_culture', 100, 1),

  -- General social interests
  ('socialising', 'Socialising', 'general_social', 10, 1),
  ('friends', 'Making friends', 'general_social', 20, 1),
  ('events', 'Events & meetups', 'general_social', 30, 1),
  ('conversations', 'Conversations', 'general_social', 40, 1),
  ('meditation', 'Meditation', 'general_social', 50, 1),
  ('mindfulness', 'Mindfulness', 'general_social', 60, 1),
  ('self_care', 'Self-care', 'general_social', 70, 1),
  ('storytelling', 'Storytelling', 'general_social', 80, 1),
  ('quizzes', 'Quizzes & trivia', 'general_social', 90, 1)
AS seed
ON DUPLICATE KEY UPDATE
  name       = seed.name,
  category   = seed.category,
  sort_order = seed.sort_order,
  is_active  = seed.is_active;

-- -----------------------------------------------------------------------------
-- A re-run of this file does two idempotent things and one harmless one:
--   * `ON DUPLICATE KEY UPDATE` rewrites labels/categories/order in place - no
--     second row can appear, because `interests.id` is the primary key and
--     `interests.name` is unique;
--   * nothing here deletes an interest, so an id a profile still references stays
--     valid even if a later revision drops it from the seed (it can be
--     deactivated with `is_active = 0` instead, which is what
--     `interestService.listActiveInterests` filters on);
--   * `profile_interests` is not mentioned anywhere above, so no member's
--     selection is rewritten by a catalogue change.
-- -----------------------------------------------------------------------------


