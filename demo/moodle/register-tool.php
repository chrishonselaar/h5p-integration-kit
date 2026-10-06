<?php
// Registers examples/lti-provider in the demo Moodle as an LTI 1.3 External tool and
// creates a course with a teacher, a student and one H5P activity.
// Run with demo/moodle/setup.sh (it copies this file into the container).
//
// The tool's public key is pasted in (key type "RSA key") instead of a keyset URL,
// so Moodle never has to call the tool. In Docker, Moodle can't reach localhost:5001.

define('CLI_SCRIPT', true);
require('/opt/bitnami/moodle/config.php');
require_once($CFG->dirroot . '/mod/lti/locallib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->dirroot . '/enrol/manual/lib.php');

[, $toolurl, $publickeyfile, $contentid] = $argv;
$toolname = 'H5P (LTI 1.3)';

\core\session\manager::set_user(get_admin());

// --- The External tool (site level, shown in the activity chooser) ---
$type = $DB->get_record('lti_types', ['name' => $toolname]);
if (!$type) {
    $type = new stdClass();
    $type->state = LTI_TOOL_STATE_CONFIGURED;
    $config = new stdClass();
    $config->lti_typename = $toolname;
    $config->lti_toolurl = "$toolurl/lti/launch";
    $config->lti_description = 'Interactive H5P content, hosted outside Moodle';
    $config->lti_ltiversion = LTI_VERSION_1P3;
    $config->lti_keytype = LTI_RSA_KEY;
    $config->lti_publickey = file_get_contents($publickeyfile);
    $config->lti_initiatelogin = "$toolurl/lti/login";
    $config->lti_redirectionuris = "$toolurl/lti/launch";
    $config->lti_coursevisible = LTI_COURSEVISIBLE_ACTIVITYCHOOSER;
    $config->lti_launchcontainer = LTI_LAUNCH_CONTAINER_EMBED_NO_BLOCKS;
    $config->lti_contentitem = 0;
    $config->lti_sendname = LTI_SETTING_ALWAYS;
    $config->lti_sendemailaddr = LTI_SETTING_ALWAYS;
    $config->lti_acceptgrades = LTI_SETTING_ALWAYS;
    $config->lti_forcessl = 0;
    // AGS: "Use this service for grade sync and column management"
    $config->ltiservice_gradesynchronization = 2;
    $config->ltiservice_memberships = 0;
    $config->ltiservice_toolsettings = 0;
    $typeid = lti_add_type($type, $config);
    $type = $DB->get_record('lti_types', ['id' => $typeid]);
}

// --- Demo course, users and enrolments ---
$course = $DB->get_record('course', ['shortname' => 'H5PDEMO']);
if (!$course) {
    $course = create_course((object)[
        'fullname' => 'H5P via LTI demo', 'shortname' => 'H5PDEMO', 'category' => 1,
        'format' => 'topics', 'numsections' => 1,
    ]);
}
$users = [];
foreach (['teacher' => 'editingteacher', 'student' => 'student'] as $username => $role) {
    $user = $DB->get_record('user', ['username' => $username]);
    if (!$user) {
        $id = user_create_user((object)[
            'username' => $username, 'password' => 'Demo123!', 'auth' => 'manual',
            'firstname' => ucfirst($username), 'lastname' => 'Demo',
            'email' => "$username@example.com", 'confirmed' => 1, 'mnethostid' => $CFG->mnet_localhost_id,
        ]);
        $user = $DB->get_record('user', ['id' => $id]);
    }
    update_internal_user_password($user, 'Demo123!');
    $enrol = $DB->get_record('enrol', ['courseid' => $course->id, 'enrol' => 'manual'], '*', MUST_EXIST);
    $roleid = $DB->get_field('role', 'id', ['shortname' => $role]);
    (new enrol_manual_plugin())->enrol_user($enrol, $user->id, $roleid);
    $users[$username] = $user;
}

// --- One activity that launches a fixed H5P content id (custom parameter) ---
$activityname = 'H5P quiz';
if (!$DB->record_exists('lti', ['course' => $course->id, 'name' => $activityname])) {
    $moduleinfo = (object)[
        'modulename' => 'lti', 'course' => $course->id, 'section' => 1, 'visible' => 1,
        'name' => $activityname, 'typeid' => $type->id, 'toolurl' => '',
        'instructorcustomparameters' => "h5p_content_id=$contentid",
        'launchcontainer' => LTI_LAUNCH_CONTAINER_EMBED_NO_BLOCKS,
        'instructorchoicesendname' => 1, 'instructorchoicesendemailaddr' => 1,
        'instructorchoiceacceptgrades' => 1, 'grade' => 100,
        'introeditor' => ['text' => '', 'format' => FORMAT_HTML, 'itemid' => 0],
    ];
    create_module($moduleinfo);
}

// Output the platform entry for examples/lti-provider/tool_config.json
$issuer = $CFG->wwwroot;
echo json_encode([
    'issuer' => $issuer,
    'client_id' => $type->clientid,
    'deployment_id' => (string)$type->id,
    'auth_login_url' => "$issuer/mod/lti/auth.php",
    'auth_token_url' => "$issuer/mod/lti/token.php",
    'key_set_url' => "$issuer/mod/lti/certs.php",
    'course_url' => "$issuer/course/view.php?id={$course->id}",
]), "\n";
