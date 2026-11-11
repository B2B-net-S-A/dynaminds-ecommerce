<?php
// Execute with official WP-CLI, after core install and the pinned Woo plugin activation.
// Only owned fresh stores. These are genuine Woo objects, not a protocol simulation.
if (!defined('WP_CLI') || !WP_CLI || !class_exists('WooCommerce')) {
    throw new RuntimeException('Official WP-CLI and active WooCommerce required');
}
$slot = getenv('DYNA_WOO_SLOT');
if (!in_array($slot, array('a', 'b', 'c', 'd', 'e'), true) || WC_VERSION !== '11.2.1' || get_bloginfo('version') !== '7.1.3') {
    WP_CLI::error('Fixed slot and official pinned versions required');
}
$origin = 'https://localhost:' . (18443 + ord($slot) - ord('a'));
if (get_option('siteurl') !== $origin || get_option('home') !== $origin || !in_array('woocommerce/woocommerce.php', (array) get_option('active_plugins'), true)) {
    WP_CLI::error('Owned HTTPS store identity mismatch');
}
$marker = 'dynaminds_official_woo_bootstrap_v1';
$previous = get_option($marker);
if ($previous !== false) {
    // Never recreate objects after a missing/uncertain acknowledgement or a partial setup.
    WP_CLI::error('Bootstrap already attempted; read existing objects before any further action');
}
if (!add_option($marker, array('state' => 'started', 'slot' => $slot, 'origin' => $origin), '', false)) {
    WP_CLI::error('Bootstrap admission not acknowledged');
}
update_option('woocommerce_currency', 'PLN');
update_option('woocommerce_default_country', 'PL');
update_option('woocommerce_calc_taxes', 'no');
update_option('woocommerce_manage_stock', 'yes');
update_option('woocommerce_allow_tracking', 'no');
update_option('woocommerce_task_list_hidden', 'yes');
update_option('permalink_structure', '/%postname%/');
flush_rewrite_rules(true);
$product = new WC_Product_Simple();
$product->set_name('Owned official Woo probe ' . strtoupper($slot));
$product->set_sku('DYNA-WOO-' . strtoupper($slot) . '-001');
$product->set_regular_price('17.01');
$product->set_manage_stock(true);
$product->set_stock_quantity(20);
$product->set_backorders('no');
$product->set_status('publish');
$product_id = $product->save();
if (!$product_id) {
    WP_CLI::error('Native product save not acknowledged; do not replay bootstrap');
}
$order = wc_create_order(array('status' => 'pending'));
if (is_wp_error($order)) {
    WP_CLI::error('Native Woo order creation failed; do not replay bootstrap');
}
$order->set_currency('PLN');
$order->set_address(array('first_name' => 'Owned', 'last_name' => 'Fixture ' . strtoupper($slot), 'address_1' => 'Testowa 1', 'city' => 'Warszawa', 'postcode' => '00-001', 'country' => 'PL', 'email' => 'fixture-' . $slot . '@example.invalid'), 'billing');
$order->add_product($product, 1);
$order->set_payment_method('bacs');
$order->calculate_totals();
$order->save();
$stored_product = wc_get_product($product_id);
$stored_order = wc_get_order($order->get_id());
$items = $stored_order ? array_values($stored_order->get_items()) : array();
if (!$stored_product || $stored_product->get_sku() !== $product->get_sku() || $stored_product->get_stock_quantity() !== 20 || !$stored_order || $stored_order->get_status() !== 'pending' || $stored_order->get_currency() !== 'PLN' || count($items) !== 1 || $items[0]->get_product_id() !== $product_id || $items[0]->get_quantity() !== 1 || wc_format_decimal($stored_order->get_total(), 2) !== '17.01') {
    WP_CLI::error('Native fixture readback differs; preserve started marker and inspect objects');
}
$result = array('state' => 'complete', 'slot' => $slot, 'origin' => $origin, 'product_id' => $product_id, 'order_id' => $order->get_id(), 'sku' => $product->get_sku(), 'provider_account_verified' => false, 'scale_accepted' => false);
update_option($marker, $result, false);
if (get_option($marker) !== $result) {
    WP_CLI::error('Bootstrap completion acknowledgement missing; inspect marker and objects');
}
WP_CLI::line(wp_json_encode($result));
