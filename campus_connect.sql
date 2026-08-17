DROP DATABASE IF EXISTS campus_connect;
CREATE DATABASE campus_connect CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE campus_connect;

CREATE TABLE roles (
  role_id INT PRIMARY KEY AUTO_INCREMENT,
  role_name VARCHAR(30) NOT NULL UNIQUE
);

CREATE TABLE departments (
  dept_id INT PRIMARY KEY AUTO_INCREMENT,
  dept_name VARCHAR(100) NOT NULL UNIQUE,
  dept_code VARCHAR(20) NOT NULL UNIQUE
);

CREATE TABLE users (
  user_id INT PRIMARY KEY AUTO_INCREMENT,
  university_id VARCHAR(30) UNIQUE,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(120) NOT NULL UNIQUE,
  password_hash CHAR(64) NOT NULL,
  phone VARCHAR(30),
  dept_id INT,
  role_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_dept FOREIGN KEY (dept_id) REFERENCES departments(dept_id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(role_id)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE categories (
  category_id INT PRIMARY KEY AUTO_INCREMENT,
  category_name VARCHAR(80) NOT NULL UNIQUE
);

CREATE TABLE products (
  product_id INT PRIMARY KEY AUTO_INCREMENT,
  seller_id INT NOT NULL,
  category_id INT NOT NULL,
  product_name VARCHAR(120) NOT NULL,
  description VARCHAR(500),
  price DECIMAL(10,2) NOT NULL,
  item_condition VARCHAR(30) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Available',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_product_price CHECK (price >= 0),
  CONSTRAINT chk_product_status CHECK (status IN ('Available','Sold')),
  CONSTRAINT fk_products_seller FOREIGN KEY (seller_id) REFERENCES users(user_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories(category_id)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE wishlists (
  user_id INT NOT NULL,
  product_id INT NOT NULL,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, product_id),
  CONSTRAINT fk_wishlist_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_wishlist_product FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE
);

CREATE TABLE projects (
  project_id INT PRIMARY KEY AUTO_INCREMENT,
  creator_id INT NOT NULL,
  title VARCHAR(150) NOT NULL,
  description VARCHAR(700),
  status VARCHAR(20) NOT NULL DEFAULT 'Open',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_project_status CHECK (status IN ('Open','Closed')),
  CONSTRAINT fk_projects_creator FOREIGN KEY (creator_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE skills (
  skill_id INT PRIMARY KEY AUTO_INCREMENT,
  skill_name VARCHAR(80) NOT NULL UNIQUE
);

CREATE TABLE project_skills (
  project_id INT NOT NULL,
  skill_id INT NOT NULL,
  PRIMARY KEY (project_id, skill_id),
  CONSTRAINT fk_ps_project FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
  CONSTRAINT fk_ps_skill FOREIGN KEY (skill_id) REFERENCES skills(skill_id) ON DELETE CASCADE
);

CREATE TABLE project_applications (
  application_id INT PRIMARY KEY AUTO_INCREMENT,
  project_id INT NOT NULL,
  applicant_id INT NOT NULL,
  application_message VARCHAR(500),
  status VARCHAR(20) NOT NULL DEFAULT 'Pending',
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_project_applicant UNIQUE (project_id, applicant_id),
  CONSTRAINT chk_application_status CHECK (status IN ('Pending','Accepted','Rejected')),
  CONSTRAINT fk_pa_project FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
  CONSTRAINT fk_pa_applicant FOREIGN KEY (applicant_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE team_members (
  project_id INT NOT NULL,
  user_id INT NOT NULL,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, user_id),
  CONSTRAINT fk_tm_project FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
  CONSTRAINT fk_tm_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE courses (
  course_id INT PRIMARY KEY AUTO_INCREMENT,
  course_code VARCHAR(30) NOT NULL UNIQUE,
  course_name VARCHAR(120) NOT NULL,
  dept_id INT,
  CONSTRAINT fk_courses_dept FOREIGN KEY (dept_id) REFERENCES departments(dept_id) ON DELETE SET NULL
);

CREATE TABLE resources (
  resource_id INT PRIMARY KEY AUTO_INCREMENT,
  uploader_id INT NOT NULL,
  course_id INT NOT NULL,
  title VARCHAR(150) NOT NULL,
  resource_type VARCHAR(40) NOT NULL,
  file_url VARCHAR(500),
  upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  download_count INT NOT NULL DEFAULT 0,
  CONSTRAINT chk_download_count CHECK (download_count >= 0),
  CONSTRAINT fk_resources_user FOREIGN KEY (uploader_id) REFERENCES users(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_resources_course FOREIGN KEY (course_id) REFERENCES courses(course_id) ON DELETE RESTRICT
);

CREATE TABLE lost_found_reports (
  report_id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  item_name VARCHAR(120) NOT NULL,
  description VARCHAR(500),
  report_type VARCHAR(20) NOT NULL,
  location VARCHAR(150),
  report_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Open',
  CONSTRAINT chk_report_type CHECK (report_type IN ('Lost','Found')),
  CONSTRAINT chk_report_status CHECK (status IN ('Open','Resolved')),
  CONSTRAINT fk_lf_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE events (
  event_id INT PRIMARY KEY AUTO_INCREMENT,
  created_by INT NOT NULL,
  event_name VARCHAR(150) NOT NULL,
  description VARCHAR(700),
  venue VARCHAR(150),
  event_date DATETIME NOT NULL,
  registration_deadline DATETIME,
  capacity INT NOT NULL DEFAULT 50,
  CONSTRAINT chk_event_capacity CHECK (capacity > 0),
  CONSTRAINT fk_events_creator FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE RESTRICT
);

CREATE TABLE event_registrations (
  event_id INT NOT NULL,
  user_id INT NOT NULL,
  registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, user_id),
  CONSTRAINT fk_er_event FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
  CONSTRAINT fk_er_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_resources_course ON resources(course_id);
CREATE INDEX idx_lf_status_type ON lost_found_reports(status, report_type);
CREATE INDEX idx_events_date ON events(event_date);

INSERT INTO roles(role_name) VALUES ('Student'), ('Teacher'), ('Admin');

INSERT INTO departments(dept_name, dept_code) VALUES
('Computer Science and Engineering', 'CSE'),
('Electrical and Electronic Engineering', 'EEE'),
('Business Administration', 'BBA'),
('Economics', 'ECO');

INSERT INTO categories(category_name) VALUES
('Books'), ('Electronics'), ('Accessories'), ('Stationery'), ('Others');

INSERT INTO courses(course_code, course_name, dept_id) VALUES
('CSE302', 'Database Systems', 1),
('CSE110', 'Programming Language I', 1),
('CSE246', 'Algorithms', 1),
('CSE347', 'Information System Analysis and Design', 1),
('EEE101', 'Electrical Circuits I', 2);

INSERT INTO skills(skill_name) VALUES
('JavaScript'), ('Node.js'), ('SQL'), ('Python'), ('UI/UX Design'), ('Web Development'), ('Database Design'), ('Presentation');

-- Demo passwords are SHA-256 through MySQL SHA2().
INSERT INTO users(university_id, name, email, password_hash, phone, dept_id, role_id) VALUES
('2026-1-60-001', 'Demo Student', 'student@campusconnect.local', SHA2('student123',256), '01700000000', 1, 1),
('T-CSE-001', 'Dr. Farhana Rahman', 'teacher@campusconnect.local', SHA2('teacher123',256), '01800000000', 1, 2),
(NULL, 'System Admin', 'admin@campusconnect.local', SHA2('admin123',256), NULL, NULL, 3),
('2025-3-60-117', 'Nafis Ahmed', 'nafis@campusconnect.local', SHA2('student123',256), '01910000000', 1, 1),
('2025-2-10-031', 'Tasnia Islam', 'tasnia@campusconnect.local', SHA2('student123',256), '01610000000', 3, 1);

INSERT INTO products(seller_id, category_id, product_name, description, price, item_condition, status) VALUES
(1, 1, 'Database Systems Book', 'CSE302 reference book with clean notes.', 450.00, 'Good', 'Available'),
(4, 2, 'Scientific Calculator', 'Casio fx-991ES PLUS, fully working.', 1150.00, 'Like New', 'Available'),
(5, 4, 'Presentation Clicker', 'USB wireless clicker for class presentations.', 700.00, 'Good', 'Available');

INSERT INTO projects(creator_id, title, description, status) VALUES
(1, 'Smart Campus App', 'Looking for teammates for a Node.js and SQL campus application.', 'Open'),
(4, 'EWU Club Event Portal', 'Need a UI/UX teammate for an event registration prototype.', 'Open'),
(5, 'Business Analytics Dashboard', 'Seeking a developer to visualize survey data.', 'Open');

INSERT INTO project_skills(project_id, skill_id) VALUES
(1,2),(1,3),(1,6),(2,5),(2,6),(3,1),(3,5);

INSERT INTO resources(uploader_id, course_id, title, resource_type, file_url) VALUES
(2, 1, 'CSE302 Normalization Notes', 'Lecture Notes', 'https://example.com/cse302-normalization'),
(1, 1, 'SQL JOIN Practice Sheet', 'Practice', 'https://example.com/sql-joins'),
(2, 3, 'Algorithms Complexity Summary', 'Cheat Sheet', 'https://example.com/algorithms-summary');

INSERT INTO lost_found_reports(user_id, item_name, description, report_type, location, report_date, status) VALUES
(1, 'Black Calculator', 'Casio calculator with a small blue sticker.', 'Lost', 'CSE Lab', CURDATE(), 'Open'),
(4, 'Student ID Card', 'Found an EWU ID card after afternoon class.', 'Found', 'Academic Building, Level 5', CURDATE(), 'Open'),
(5, 'Water Bottle', 'Steel bottle with black lid.', 'Lost', 'Library', DATE_SUB(CURDATE(), INTERVAL 1 DAY), 'Open');

INSERT INTO events(created_by, event_name, description, venue, event_date, registration_deadline, capacity) VALUES
(2, 'Database Design Workshop', 'Hands-on ER modeling, normalization and SQL practice.', 'Room 550', DATE_ADD(NOW(), INTERVAL 10 DAY), DATE_ADD(NOW(), INTERVAL 8 DAY), 60),
(3, 'Campus Connect Demo Day', 'Showcase student database projects and receive feedback.', 'Lecture Gallery', DATE_ADD(NOW(), INTERVAL 16 DAY), DATE_ADD(NOW(), INTERVAL 14 DAY), 120),
(2, 'CSE Project Team Meetup', 'Meet potential teammates and discuss semester projects.', 'CSE Common Space', DATE_ADD(NOW(), INTERVAL 5 DAY), DATE_ADD(NOW(), INTERVAL 4 DAY), 45);

INSERT INTO event_registrations(event_id,user_id) VALUES (1,1),(1,4),(2,1),(3,5);
INSERT INTO wishlists(user_id,product_id) VALUES (1,2),(4,1);
INSERT INTO project_applications(project_id,applicant_id,application_message,status) VALUES
(2,1,'I can help with Node.js and database integration.','Pending'),
(1,4,'I would like to work on the API and testing.','Pending');
