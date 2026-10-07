<?php
// Demo Moodle helper, run inside the container by setup.sh:
//   php moodle-setup.php site              allow the tool on localhost; course, teacher, student
//   php moodle-setup.php registration-url  URL that starts LTI Dynamic Registration (what Moodle's
//                                          "Add LTI Advantage" button does), for the tool URL in $argv[2]
//   php moodle-setup.php activate <url>    activate the tool registered from <url>, show it in the activity chooser
define('CLI_SCRIPT', true);
require('/opt/bitnami/moodle/config.php');
require_once($CFG->dirroot . '/mod/lti/locallib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->dirroot . '/enrol/manual/lib.php');

use Firebase\JWT\JWT;
use mod_lti\local\ltiopenid\jwks_helper;
use mod_lti\local\ltiopenid\registration_helper;

\core\session\manager::set_user(get_admin());
$command = $argv[1] ?? '';

if ($command === 'site') {
    // In this demo the tool runs on localhost:5001; Moodle blocks such addresses by default
    set_config('curlsecurityblockedhosts', '');
    set_config('curlsecurityallowedport', '');

    $course = $DB->get_record('course', ['shortname' => 'H5PDEMO']);
    if (!$course) {
        $course = create_course((object)['fullname' => 'H5P via LTI demo', 'shortname' => 'H5PDEMO',
            'category' => 1, 'format' => 'topics', 'numsections' => 1]);
    }
    foreach (['teacher' => 'editingteacher', 'student' => 'student'] as $username => $role) {
        $user = $DB->get_record('user', ['username' => $username]);
        if (!$user) {
            $id = user_create_user((object)['username' => $username, 'password' => 'Demo123!', 'auth' => 'manual',
                'firstname' => ucfirst($username), 'lastname' => 'Demo', 'email' => "$username@example.com",
                'confirmed' => 1, 'mnethostid' => $CFG->mnet_localhost_id]);
            $user = $DB->get_record('user', ['id' => $id]);
        }
        update_internal_user_password($user, 'Demo123!');
        $enrol = $DB->get_record('enrol', ['courseid' => $course->id, 'enrol' => 'manual'], '*', MUST_EXIST);
        (new enrol_manual_plugin())->enrol_user($enrol, $user->id, $DB->get_field('role', 'id', ['shortname' => $role]));
    }
    echo "$CFG->wwwroot/course/view.php?id=$course->id\n";

} else if ($command === 'registration-url') {
    // Same token as mod/lti/startltiadvregistration.php
    $now = time();
    $token = ['sub' => registration_helper::get()->new_clientid(), 'scope' => registration_helper::REG_TOKEN_OP_NEW_REG,
        'iat' => $now, 'exp' => $now + HOURSECS];
    $key = jwks_helper::get_private_key();
    $url = new moodle_url($argv[2]);
    $url->param('openid_configuration', (new moodle_url('/mod/lti/openid-configuration.php'))->out(false));
    $url->param('registration_token', JWT::encode($token, $key['key'], 'RS256', $key['kid']));
    echo $url->out(false), "\n";

} else if ($command === 'activate') {
    // What the admin does on Manage tools: activate the pending tool; also offer it in the activity chooser
    // The tool registered from the URL in $argv[2] (e.g. http://localhost:5001)
    $type = $DB->get_record_sql("SELECT * FROM {lti_types} WHERE baseurl LIKE ? ORDER BY id DESC",
        [$DB->sql_like_escape($argv[2]) . '%'], IGNORE_MULTIPLE);
    if (!$type) {
        fwrite(STDERR, "No tool registered from $argv[2]\n");
        exit(1);
    }
    $DB->set_field('lti_types', 'state', LTI_TOOL_STATE_CONFIGURED, ['id' => $type->id]);
    $DB->set_field('lti_types', 'coursevisible', LTI_COURSEVISIBLE_ACTIVITYCHOOSER, ['id' => $type->id]);
    // Teachers choose per activity whether it takes grades; default it to yes
    $DB->delete_records('lti_types_config', ['typeid' => $type->id, 'name' => 'acceptgrades']);
    $DB->insert_record('lti_types_config', (object)['typeid' => $type->id, 'name' => 'acceptgrades', 'value' => LTI_SETTING_ALWAYS]);
    \cache_helper::purge_all();
    echo "Activated tool $type->id (client id $type->clientid)\n";
} else {
    fwrite(STDERR, "usage: php moodle-setup.php site | registration-url <tool url> | activate <tool url>\n");
    exit(2);
}
