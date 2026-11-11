<?php
// One WooCommerce REST key for an owned store, created by WooCommerce's own WC_Auth::create_keys (the code path of
// the store's "Approve" screen), not by SQL written here. Run only through operator.mjs `keys`:
//   wp --user=fixture_<slot> eval-file - <importer|producer>   (this file on stdin)
// Prints one JSON line {consumer_key, consumer_secret} that the operator stores in a new 0600 file. No replay.
if (!defined('WP_CLI') || !WP_CLI || !class_exists('WooCommerce') || !class_exists('WC_Auth')) {
    throw new RuntimeException('Official WP-CLI and active WooCommerce required');
}
$purpose = isset($args[0]) ? $args[0] : '';
$slot = getenv('DYNA_WOO_SLOT');
if (!in_array($purpose, array('importer', 'producer'), true) || !in_array($slot, array('a', 'b', 'c', 'd', 'e'), true) || WC_VERSION !== '11.2.1' || get_bloginfo('version') !== '7.1.3') {
    WP_CLI::error('Fixed slot, purpose and official pinned versions required');
}
$bootstrap = get_option('dynaminds_official_woo_bootstrap_v1');
$user = wp_get_current_user();
if (!is_array($bootstrap) || ($bootstrap['state'] ?? '') !== 'complete' || ($bootstrap['slot'] ?? '') !== $slot || !$user || $user->user_login !== 'fixture_' . $slot || !user_can($user, 'manage_woocommerce')) {
    WP_CLI::error('Bootstrapped store and its own administrator required');
}
global $wpdb;
$name = 'dynaminds-' . $purpose . '-' . $slot;
$existing = (int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->prefix}woocommerce_api_keys WHERE description LIKE %s", $wpdb->esc_like($name . ' - API') . '%'));
if ($existing !== 0) {
    WP_CLI::error('A key of this purpose already exists; inspect the store, never replay');
}
$create = new ReflectionMethod('WC_Auth', 'create_keys');
$create->setAccessible(true);
$key = $create->invoke(new WC_Auth(), $name, $user->ID, 'read_write');
if (!is_array($key) || $key['key_permissions'] !== 'read_write' || !preg_match('/^ck_[a-f0-9]{40}$/', $key['consumer_key']) || !preg_match('/^cs_[a-f0-9]{40}$/', $key['consumer_secret'])) {
    WP_CLI::error('Key creation not acknowledged; inspect the store, never replay');
}
WP_CLI::line(wp_json_encode(array('consumer_key' => $key['consumer_key'], 'consumer_secret' => $key['consumer_secret'])));
